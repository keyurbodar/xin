import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, eventually, fresh, recordOffers, rowOf, setRow, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { RequestsDoc } from "../../src/contracts/questions.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"

const context = BACKGROUND_CONTEXT

type ThreadRow = { readonly id: number; readonly title: string; readonly status: string }

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

async function askThread(stub: ReturnType<typeof fresh>, slug: string): Promise<Asked> {
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
    const offers = recordOffers()
    respond([offers.step("noted")])
    await turn(stub, "tools-on")
    expect(offers.latest().tools).toEqual(expect.arrayContaining(["ask_user", "pending_request"]))

    await setRow(stub, "tool-questions", false)
    respond([offers.step("noted")])
    await turn(stub, "tools-off")
    expect(offers.latest().tools).not.toContain("ask_user")
    expect(offers.latest().tools).not.toContain("pending_request")

    expect(await rowOf(stub, "questions")).toMatchObject({ disabled: false, state: { kind: "active" } })

    await setRow(stub, "tool-questions", true)
    respond([offers.step("noted")])
    await turn(stub, "tools-back")
    expect(offers.latest().tools).toEqual(expect.arrayContaining(["ask_user", "pending_request"]))
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

    expect(await rowOf(stub, "tool-questions")).toMatchObject({
      disabled: true,
      state: { kind: "disabled" },
    })
    expect(await rowOf(stub, "questions")).toMatchObject({
      disabled: false,
      state: { kind: "active" },
    })
  }, 30_000)
})
