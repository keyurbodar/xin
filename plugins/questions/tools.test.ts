import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type FauxResponseStep, type Message } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { ThreadDoc } from "../workspace/threaddoc.ts"
import { RequestsDoc, WorkspaceDoc } from "../workspace/workspace.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}
type ThreadRow = { readonly id: number; readonly title: string; readonly status: string }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const offers: string[][] = []

function offeredTools(messages: readonly Message[]): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.role !== "system") continue
    for (const tool of message.toolsAdded ?? []) names.add(tool.name)
    for (const removed of message.toolsRemoved ?? []) names.delete(removed.name)
  }
  return [...names]
}

const offer =
  (reply: string): FauxResponseStep =>
  (transcript) => {
    offers.push(offeredTools(transcript.messages))
    return fauxAssistantMessage(reply)
  }

function latestOffer(): string[] {
  const last = offers.at(-1)
  if (last === undefined) throw new Error("the faux model has not been called")
  return last
}

const setRow = async (stub: Stub, id: string, enabled: boolean): Promise<Ack> => {
  const ack = await cmd(stub, `${id}-${enabled}-${crypto.randomUUID()}`, "plugin.enable", { id, enabled })
  expect(ack.result).toMatchObject({ application: "applied", row: { disabled: !enabled } })
  return ack
}

async function turn(stub: Stub, requestId: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(M8_MODEL)
    await home.submit("go", requestId)
    await home.harness.waitForIdle(context)
  })
}

const threads = async (home: Home, projectId: string): Promise<ThreadRow[]> => {
  const workspace = await home.harness.snapshot(WorkspaceDoc, context)
  const ids = workspace?.projects[projectId]?.threadIds ?? []
  const found: ThreadRow[] = []
  for (const id of ids) {
    const doc = await home.harness.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc !== undefined) found.push({ id, title: doc.title, status: doc.status })
  }
  return found
}

const threadOf = async (home: Home, projectId: string): Promise<ThreadRow | undefined> => {
  const found = await threads(home, projectId)
  return found[0]
}

const openRequests = async (home: Home, threadId: number): Promise<{ requestId: string; question: string }[]> => {
  const doc = await home.harness.snapshot(RequestsDoc, threadId as ConversationId, context)
  if (doc === undefined) return []
  return Object.entries(doc.open).map(([requestId, request]) => ({ requestId, question: request.question }))
}

type Asked = { readonly projectId: string; readonly threadId: number; readonly requestId: string }

async function askThread(stub: Stub, slug: string): Promise<Asked> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const project = created.result as { id: string; coordinatorId: number }
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M6_MODEL }, context)
  })
  const sent = await cmd(stub, `${slug}-1`, "message.send", { conv: project.coordinatorId, text: "delegate ask" })
  expect(sent.ok, JSON.stringify(sent)).toBe(true)
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
  await eventually(stub, async (home: Home) => (await threadOf(home, project.id))?.status === "waiting")
  const thread = await runInDurableObject(stub, (home: Home) => threadOf(home, project.id))
  if (thread === undefined) throw new Error("no thread")
  const open = await runInDurableObject(stub, (home: Home) => openRequests(home, thread.id))
  const requestId = open[0]?.requestId
  if (requestId === undefined) throw new Error("no open request")
  return { projectId: project.id, threadId: thread.id, requestId }
}

describe("tool-questions row", () => {
  it("offers ask_user and pending_request only while the tool row is active", async () => {
    const stub = fresh()
    respond([offer("noted")])
    await turn(stub, "tools-on")
    expect(latestOffer()).toEqual(expect.arrayContaining(["ask_user", "pending_request"]))

    await setRow(stub, "tool-questions", false)
    respond([offer("noted")])
    await turn(stub, "tools-off")
    expect(latestOffer()).not.toContain("ask_user")
    expect(latestOffer()).not.toContain("pending_request")

    const listed = await cmd(stub, "list-after-off", "plugin.list")
    const rows = Array.isArray(listed.result) ? listed.result : []
    const questions = rows.find((row) => field(row, "id") === "questions")
    expect(questions).toMatchObject({ disabled: false, state: { kind: "active" } })

    await setRow(stub, "tool-questions", true)
    respond([offer("noted")])
    await turn(stub, "tools-back")
    expect(latestOffer()).toEqual(expect.arrayContaining(["ask_user", "pending_request"]))
  }, 30_000)

  it("keeps the questions service answering after the tool row is disabled", async () => {
    const stub = fresh()
    const { projectId, threadId, requestId } = await askThread(stub, "ask-off")
    expect(await runInDurableObject(stub, (home: Home) => openRequests(home, threadId))).toEqual([
      { requestId, question: "Which color?" },
    ])

    await setRow(stub, "tool-questions", false)
    await runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))

    const answered = await cmd(stub, "answer-off", "request.respond", { threadId, requestId, answer: "red" })
    expect(answered.ok, JSON.stringify(answered)).toBe(true)
    expect(answered.result).toMatchObject({ kind: "answered", run: 2 })
    await eventually(stub, async (home: Home) => (await threadOf(home, projectId))?.status === "completed")

    const listed = await cmd(stub, "list-service", "plugin.list")
    const rows = Array.isArray(listed.result) ? listed.result : []
    expect(rows.find((row) => field(row, "id") === "tool-questions")).toMatchObject({
      disabled: true,
      state: { kind: "disabled" },
    })
    expect(rows.find((row) => field(row, "id") === "questions")).toMatchObject({
      disabled: false,
      state: { kind: "active" },
    })
  }, 30_000)
})
