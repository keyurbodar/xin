import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { RequestsDoc } from "../../src/contracts/questions.ts"
import { threadIdsOfProject, WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import { homeRequests } from "./questions.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type ThreadRow = { readonly id: number; readonly title: string; readonly status: string }

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number }
}

async function chooseModel(stub: Stub, coordinatorId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M6_MODEL }, context)
  })
}

async function send(stub: Stub, id: string, coordinatorId: number, text: string): Promise<void> {
  const outcome = await cmd(stub, id, "message.send", { conv: coordinatorId, text })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

async function fireUsers(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.fireIntake("question", Date.now() + 3_600_000)
    await home.fireIntake("user")
  })
  await runDurableObjectAlarm(stub)
}

const threads = async (home: Home, projectId: string): Promise<ThreadRow[]> => {
  const workspace = await home.harness.snapshot(WorkspaceDoc, context)
  const ids = threadIdsOfProject(workspace, projectId)
  const found: ThreadRow[] = []
  for (const id of ids) {
    const doc = await home.harness.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc !== undefined) found.push({ id, title: doc.title, status: doc.status })
  }
  return found
}

type RequestRow = { readonly requestId: string; readonly question: string; readonly answer?: string }

const requestsOf = async (home: Home, threadId: number): Promise<{ open: RequestRow[]; answered: RequestRow[] }> => {
  const doc = await home.harness.snapshot(RequestsDoc, threadId as ConversationId, context)
  if (doc === undefined) return { open: [], answered: [] }
  return {
    open: Object.entries(doc.open).map(([requestId, request]) => ({ requestId, question: request.question })),
    answered: Object.entries(doc.answered).map(([requestId, request]) => ({
      requestId,
      question: request.question,
      answer: request.answer,
    })),
  }
}

const threadOf = async (home: Home, projectId: string): Promise<ThreadRow | undefined> => {
  const found = await threads(home, projectId)
  return found[0]
}

type ReportRow = { commandId: string; status: string; body: string }

const reports = async (home: Home): Promise<ReportRow[]> =>
  (await home.intake())
    .filter((item) => item.kind === "report")
    .map((item) => ({ commandId: item.commandId, status: item.status, body: item.body }))

function statusOf(body: string): string {
  const value: unknown = JSON.parse(body)
  if (typeof value !== "object" || value === null) return ""
  const status = Reflect.get(value, "status")
  return typeof status === "string" ? status : ""
}

const questions = async (home: Home): Promise<{ commandId: string; status: string }[]> =>
  (await home.intake())
    .filter((item) => item.kind === "question")
    .map((item) => ({ commandId: item.commandId, status: item.status }))

type Asked = { projectId: string; threadId: number; requestId: string }

async function askThread(stub: Stub, slug: string, fire: (stub: Stub) => Promise<void> = fireNow): Promise<Asked> {
  const project = await makeProject(stub, slug)
  await chooseModel(stub, project.coordinatorId)
  await send(stub, `${slug}-1`, project.coordinatorId, "delegate ask")
  await fire(stub)
  await eventually(stub, async (home: Home) => (await threadOf(home, project.id))?.status === "waiting")
  const thread = await runInDurableObject(stub, (home: Home) => threadOf(home, project.id))
  if (thread === undefined) throw new Error("no thread")
  const open = await runInDurableObject(stub, (home: Home) => requestsOf(home, thread.id))
  const requestId = open.open[0]?.requestId
  if (requestId === undefined) throw new Error("no open request")
  return { projectId: project.id, threadId: thread.id, requestId }
}

type ListedRequest = {
  readonly id: string
  readonly conversationId: number
  readonly projectId?: string
  readonly projectName?: string
  readonly threadTitle?: string
  readonly question: string
  readonly options?: readonly string[]
  readonly askedAt: number
}

function listed(value: unknown): ListedRequest[] {
  if (typeof value !== "object" || value === null) return []
  const requests = Reflect.get(value, "requests")
  if (!Array.isArray(requests)) return []
  return requests.filter((row): row is ListedRequest => {
    if (typeof row !== "object" || row === null) return false
    return typeof Reflect.get(row, "id") === "string" && typeof Reflect.get(row, "askedAt") === "number"
  })
}

describe("questions", () => {
  it("ends the turn on ask_user and resumes it once on request.respond", async () => {
    const stub = fresh()
    const { threadId, requestId } = await askThread(stub, "ask")

    expect(await runInDurableObject(stub, (home: Home) => requestsOf(home, threadId))).toEqual({
      open: [{ requestId, question: "Which color?" }],
      answered: [],
    })
    expect(await runInDurableObject(stub, questions)).toEqual([
      { commandId: `question:${requestId}`, status: "pending" },
    ])

    const first = await cmd(stub, "respond-1", "request.respond", { threadId, requestId, answer: "red" })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    expect(first.result).toMatchObject({ kind: "answered", run: 2 })

    const after = await runInDurableObject(stub, async (home: Home) => ({
      requests: await requestsOf(home, threadId),
      thread: await home.harness.snapshot(ThreadDoc, threadId as ConversationId, context),
      questions: await questions(home),
    }))
    expect(after.requests.open).toEqual([])
    expect(after.requests.answered).toEqual([{ requestId, question: "Which color?", answer: "red" }])
    expect(after.thread?.status).not.toBe("waiting")
    expect(after.thread?.run).toBe(2)
    expect(after.questions).toEqual([])

    await eventually(stub, async (home: Home) =>
      (await reports(home)).some(
        (row) => row.commandId === `report:${threadId}:2` && statusOf(row.body) === "completed",
      ),
    )
    await eventually(stub, async (home: Home) => {
      const doc = await home.harness.snapshot(ThreadDoc, threadId as ConversationId, context)
      return doc?.status === "completed"
    })
    const settled = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(ThreadDoc, threadId as ConversationId, context),
    )
    expect(settled?.statusLine).toBeUndefined()

    const second = await cmd(stub, "respond-2", "request.respond", { threadId, requestId, answer: "blue" })
    expect(second.ok, JSON.stringify(second)).toBe(true)
    expect(second.result).toMatchObject({ kind: "already_answered", answer: "red" })
    const rows = await runInDurableObject(stub, reports)
    expect(rows.filter((row) => row.commandId === `report:${threadId}:2`)).toHaveLength(1)
  }, 20_000)

  it("answers a waiting thread through the coordinator's pending_request tool", async () => {
    const stub = fresh()
    const { projectId, threadId, requestId } = await askThread(stub, "ask-tool")

    await fireNow(stub)
    await eventually(stub, async (home: Home) =>
      (await reports(home)).some((row) => row.commandId === `report:${threadId}:2`),
    )
    await eventually(stub, async (home: Home) => (await threadOf(home, projectId))?.status === "completed")
    expect(await runInDurableObject(stub, (home: Home) => requestsOf(home, threadId))).toMatchObject({
      open: [],
      answered: [{ requestId, answer: "blue" }],
    })
    const asked = await runInDurableObject(stub, questions)
    expect(asked.find((row) => row.commandId === `question:${requestId}`)?.status).not.toBe("pending")
  }, 20_000)

  it("lists pending questions newest first, bounded, and drops answered ones", async () => {
    const stub = fresh()
    const first = await askThread(stub, "list-a")
    const second = await askThread(stub, "list-b", fireUsers)

    const all = await cmd(stub, "list-1", "request.list", {})
    expect(all.ok, JSON.stringify(all)).toBe(true)
    const rows = listed(all.result)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.askedAt).toBeGreaterThanOrEqual(rows[1]?.askedAt ?? 0)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(first.requestId)).toMatchObject({
      conversationId: first.threadId,
      projectId: first.projectId,
      projectName: "list-a",
      question: "Which color?",
      options: ["red", "blue"],
    })
    expect(byId.get(first.requestId)?.threadTitle).toContain("delegate ask")
    expect(byId.get(second.requestId)).toMatchObject({
      conversationId: second.threadId,
      projectId: second.projectId,
      projectName: "list-b",
    })

    const limited = await cmd(stub, "list-2", "request.list", { limit: 1 })
    expect(listed(limited.result)).toHaveLength(1)
    const carried = await runInDurableObject(stub, (home: Home) => homeRequests(home.harness, 5))
    expect(carried).toMatchObject({ requests: rows.map((row) => ({ id: row.id, projectName: row.projectName })) })
    expect(await cmd(stub, "list-3", "request.list", { limit: 0 })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })

    const denied = await runInDurableObject(stub, (home: Home) =>
      home.commands.run(
        { id: "list-agent" as CommandId, op: "request.list", args: {} },
        { kind: "agent", conversationId: first.threadId as ConversationId },
      ),
    )
    expect(denied).toMatchObject({ kind: "rejected", code: "forbidden" })

    const answered = await cmd(stub, "list-respond", "request.respond", {
      threadId: first.threadId,
      requestId: first.requestId,
      answer: "red",
    })
    expect(answered.ok, JSON.stringify(answered)).toBe(true)
    const after = listed((await cmd(stub, "list-4", "request.list", {})).result)
    expect(after.map((row) => row.id)).toEqual([second.requestId])
  }, 30_000)
})
