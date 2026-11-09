import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import type { ThreadSettled } from "../../src/contracts/threads.ts"
import { M5_MODEL } from "../../test/plugins/m5.ts"
import { recorded } from "../../test/plugins/settled.ts"
import { cmd, eventually, fresh, setRow } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const DIRECT_KEY = "test.settled.direct"

type Stub = ReturnType<typeof fresh>

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number }
}

async function chooseModel(stub: Stub, coordinatorId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M5_MODEL }, context)
  })
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

const reportCount = async (home: Home): Promise<number> =>
  (await home.intake()).filter((item) => item.kind === "report").length

const directEvents = (state: DurableObjectState): readonly ThreadSettled[] =>
  state.storage.kv.get<ThreadSettled[]>(DIRECT_KEY) ?? []

describe("thread/settled", () => {
  it("emits one event with the result when a thread completes", async () => {
    const stub = fresh()
    await setRow(stub, "settled", true)
    const project = await makeProject(stub, "settled")
    await chooseModel(stub, project.coordinatorId)
    const sent = await cmd(stub, "settled-1", "message.send", { conv: project.coordinatorId, text: "delegate one" })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await fireNow(stub)

    await eventually(stub, async (_home, state) => recorded(state.storage).length === 1)
    const events = await runInDurableObject(stub, (_home, state) => Promise.resolve(recorded(state.storage)))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      threadId: expect.any(Number),
      parentId: project.coordinatorId,
      projectId: project.id,
      title: "Thread 1",
      status: "completed",
      result: "thread answer: do task 1",
    })
  }, 20_000)

  it("keeps reporting when a listener throws or rejects", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "resilient")
    await runInDurableObject(stub, (home: Home, state: DurableObjectState) => {
      home.loader.ctx.on("thread/settled", () => {
        throw new Error("sync listener exploded")
      })
      home.loader.ctx.on("thread/settled", async () => {
        await Promise.resolve()
        throw new Error("async listener exploded")
      })
      home.loader.ctx.on("thread/settled", (event) => {
        state.storage.kv.put(DIRECT_KEY, [...directEvents(state), event])
      })
    })
    await chooseModel(stub, project.coordinatorId)
    const sent = await cmd(stub, "resilient-1", "message.send", { conv: project.coordinatorId, text: "delegate one" })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await fireNow(stub)

    await eventually(stub, async (_home, state) => directEvents(state).length === 1)
    expect(await runInDurableObject(stub, (home: Home) => reportCount(home))).toBe(1)
    const events = await runInDurableObject(stub, (_home, state) => Promise.resolve(directEvents(state)))
    expect(events[0]).toMatchObject({ projectId: project.id, status: "completed", result: "thread answer: do task 1" })
  }, 20_000)
})
