import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { beforeEach, describe, expect, it } from "vitest"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { hold, resetAlt, THINKING_MODEL, WIDE_MODEL } from "../../test/plugins/m3.ts"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const STALLED_MS = 125_000

type Stub = ReturnType<typeof fresh>
type Brief = { readonly task?: string; readonly model?: { provider: string; modelId: string } }

async function makeProject(stub: Stub, slug: string, settings?: object): Promise<number> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const project = created.result as { id: string; coordinatorId: number }
  if (settings !== undefined) {
    const updated = await cmd(stub, `update-${slug}`, "project.update", { id: project.id, settings })
    expect(updated.ok, JSON.stringify(updated)).toBe(true)
  }
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: THINKING_MODEL, thinkingLevel: "high" }, context)
  })
  return project.coordinatorId
}

const delegate = (stub: Stub, callerId: number, key: string, brief: Brief = {}) =>
  runInDurableObject(stub, (home: Home) =>
    home.loader.ctx.threads.delegate(
      { conversationId: callerId as ConversationId, taskId: `task-${key}` },
      {
        task: brief.task ?? "say hi",
        title: key,
        mode: "async",
        clientRequestId: key,
        ...(brief.model === undefined ? {} : { choice: { model: brief.model } }),
      },
      context,
    ),
  )

const started = (outcome: unknown): number => {
  expect(outcome).toMatchObject({ kind: "started" })
  return (outcome as { threadId: number }).threadId
}

const agentOf = (stub: Stub, conversationId: number) =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) throw new Error(`no conversation ${conversationId}`)
    const agent = await conversation.agent(context)
    return { model: agent.model, tools: agent.tools.map((tool) => tool.name) }
  })

const docOf = (stub: Stub, threadId: number) =>
  runInDurableObject(stub, (home: Home) => home.harness.snapshot(ThreadDoc, threadId as ConversationId, context))

const settledAt = (stub: Stub, threadId: number, run: number, status = "completed") =>
  eventually(stub, async (home) => {
    const doc = await home.harness.snapshot(ThreadDoc, threadId as ConversationId, context)
    return (doc?.run ?? 1) === run && doc?.status === status
  })

const statusFrom = (stub: Stub, callerId: number, threadId: number) =>
  runInDurableObject(stub, (home: Home) =>
    home.loader.ctx.threads.status({ conversationId: callerId as ConversationId, taskId: "status" }, threadId, context),
  )

const userTexts = async (home: Home, conversationId: number): Promise<string[]> => {
  const conversation = await home.harness.conversation(conversationId as ConversationId, context)
  const page = await conversation?.entries({ order: "ascending" }, 200, undefined, context)
  return (page?.items ?? []).flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)),
  )
}

const reportKeys = (stub: Stub) =>
  runInDurableObject(stub, async (home: Home) =>
    (await home.intake()).filter((item) => item.kind === "report").map((item) => `${item.commandId}>${item.target}`),
  )

const reportersIn = async (home: Home, threadId: number): Promise<number[]> =>
  (await home.harness.inspect(context)).tasks
    .filter(
      (task) => task.record.kind === "xin.reporter" && Reflect.get(Object(task.record.input), "threadId") === threadId,
    )
    .map((task) => task.record.conversationId)

const reportersOf = (stub: Stub, threadId: number) =>
  runInDurableObject(stub, (home: Home) => reportersIn(home, threadId))

describe("nested threads", () => {
  beforeEach(resetAlt)

  it("removes delegate_task from threads at the default threadDepth of 1", async () => {
    const stub = fresh()
    const coordinatorId = await makeProject(stub, "flat")
    const threadId = started(await delegate(stub, coordinatorId, "flat"))
    const thread = await agentOf(stub, threadId)
    for (const tool of ["delegate_task", "thread_create", "thread_send", "task_status", "task_cancel"])
      expect(thread.tools).not.toContain(tool)
    expect((await docOf(stub, threadId))?.depth).toBeUndefined()
    expect(await delegate(stub, threadId, "flat-child")).toEqual({ kind: "not_coordinator" })
  })

  it("lets a thread delegate at threadDepth 2; its child inherits its model, reports to it, and cannot delegate", async () => {
    const stub = fresh()
    const coordinatorId = await makeProject(stub, "deep", { threadDepth: 2 })
    const parentId = started(await delegate(stub, coordinatorId, "parent", { model: WIDE_MODEL }))
    const sibling = started(await delegate(stub, coordinatorId, "sibling"))
    const parent = await agentOf(stub, parentId)
    expect(parent.tools).toEqual(expect.arrayContaining(["delegate_task", "task_status", "task_cancel", "thread_send"]))
    for (const tool of ["thread_create", "thread_list", "thread_read", "pending_request"])
      expect(parent.tools).not.toContain(tool)
    await settledAt(stub, parentId, 1)

    const childId = started(await delegate(stub, parentId, "child"))
    const child = await agentOf(stub, childId)
    expect(child.model).toEqual(WIDE_MODEL)
    expect(child.tools.every((tool) => parent.tools.includes(tool))).toBe(true)
    expect(child.tools).not.toContain("delegate_task")
    expect(await docOf(stub, childId)).toMatchObject({
      parentId,
      depth: 2,
      spaceId: (await docOf(stub, parentId))?.spaceId,
    })
    expect(await delegate(stub, childId, "grandchild")).toEqual({ kind: "not_coordinator" })

    expect(await statusFrom(stub, parentId, childId)).toMatchObject({ kind: "thread" })
    expect(await statusFrom(stub, parentId, sibling)).toEqual({ kind: "none" })
    expect(await statusFrom(stub, childId, parentId)).toEqual({ kind: "none" })
    const listed = await runInDurableObject(stub, (home: Home) =>
      home.loader.ctx.threads.list({ conversationId: coordinatorId as ConversationId, taskId: "list" }, {}),
    )
    if (listed.kind !== "threads") throw new Error(listed.kind)
    const rows = listed.threads
    expect(rows.find((row) => row.id === childId)).toMatchObject({ parentId, depth: 2 })
    expect(rows.find((row) => row.id === parentId)?.depth).toBeUndefined()

    await settledAt(stub, parentId, 2)
    await runInDurableObject(stub, async (home: Home) => {
      const texts = await userTexts(home, parentId)
      expect(texts.some((text) => text.includes(`<thread id=\\"${childId}\\"`))).toBe(true)
    })
    const keys = await reportKeys(stub)
    expect(keys).toContain(`report:${parentId}:2>${coordinatorId}`)
    expect(keys.filter((key) => key.startsWith(`report:${childId}:`))).toEqual([])
    const workspace = await cmd(stub, "read-deep", "workspace.read", {})
    expect(JSON.stringify(workspace.result)).toContain(`"parentId":${parentId},"depth":2`)
  })

  it("queues a report that lands while the parent is still working and starts the parent's next run with it", async () => {
    const stub = fresh()
    const coordinatorId = await makeProject(stub, "busy", { threadDepth: 2 })
    const release = hold()
    let parentId = 0
    try {
      parentId = started(await delegate(stub, coordinatorId, "busy-parent", { task: "hold on", model: WIDE_MODEL }))
      const childId = started(await delegate(stub, parentId, "busy-child"))
      await eventually(stub, async (home) => {
        const doc = await home.harness.snapshot(ThreadDoc, parentId as ConversationId, context)
        return doc?.status === "working" && doc.inbox?.[0]?.key === `report:${childId}:1`
      })
      expect((await reportKeys(stub)).filter((key) => key.startsWith(`report:${childId}:`))).toEqual([])
    } finally {
      release()
    }
    await settledAt(stub, parentId, 2)
    expect((await docOf(stub, parentId))?.inbox).toBeUndefined()
    const keys = await reportKeys(stub)
    expect(keys).toContain(`report:${parentId}:2>${coordinatorId}`)
    expect(keys.filter((key) => key.startsWith(`report:${parentId}:1`))).toEqual([])
  })

  it("reopens a finished parent when the watchdog fails its child, instead of waking it through intake", async () => {
    const stub = fresh()
    const coordinatorId = await makeProject(stub, "stall", { threadDepth: 2 })
    const parentId = started(await delegate(stub, coordinatorId, "stall-parent", { model: WIDE_MODEL }))
    await settledAt(stub, parentId, 1)
    const release = hold()
    try {
      const childId = started(await delegate(stub, parentId, "stall-child", { task: "hold forever" }))
      await runInDurableObject(stub, (home: Home) =>
        home.harness.commit(async (tx) => {
          const doc = await tx.doc(ThreadDoc, childId as ConversationId)
          doc.beatAt = Date.now() - STALLED_MS
        }, context),
      )
      await runInDurableObject(stub, async (home: Home) => {
        for (const task of (await home.harness.inspect(context)).tasks)
          if (task.record.kind === "xin.watchdog") await home.harness.abortTask(task.record.id, context)
      })
      await eventually(stub, async (home) =>
        (await home.harness.inspect(context)).tasks.every((task) => task.record.kind !== "xin.watchdog"),
      )
      await runDurableObjectAlarm(stub)
      await settledAt(stub, childId, 1, "failed")
      await settledAt(stub, parentId, 2)
      await runInDurableObject(stub, async (home: Home) => {
        const texts = await userTexts(home, parentId)
        expect(texts.some((text) => text.includes(`<thread id=\\"${childId}\\"`) && text.includes("failed"))).toBe(true)
      })
      expect((await reportKeys(stub)).filter((key) => key.startsWith(`report:${childId}:`))).toEqual([])
    } finally {
      release()
    }
  })

  it("stops a thread's working descendants with it, and keeps their Reporters with the coordinator", async () => {
    const stub = fresh()
    const coordinatorId = await makeProject(stub, "stop", { threadDepth: 3 })
    const release = hold()
    try {
      const top = started(await delegate(stub, coordinatorId, "stop-top", { task: "hold" }))
      const middle = started(await delegate(stub, top, "stop-middle", { task: "hold" }))
      const bottom = started(await delegate(stub, middle, "stop-bottom", { task: "hold" }))
      expect(await reportersOf(stub, middle)).toEqual([coordinatorId])
      expect(await reportersOf(stub, bottom)).toEqual([coordinatorId])
      expect(await reportersOf(stub, top)).toEqual([coordinatorId])

      const stopped = await cmd(stub, "stop-top", "thread.stop", { threadId: top })
      expect(stopped.result).toMatchObject({ status: "cancelled", descendants: [middle, bottom] })
      for (const id of [top, middle, bottom]) expect((await docOf(stub, id))?.status).toBe("cancelled")
      await eventually(stub, async (home) => (await reportersIn(home, bottom)).length === 0)
      expect((await reportKeys(stub)).filter((key) => key.startsWith("report:"))).toEqual([])
    } finally {
      release()
    }
  })

  it("delivers a child's report once when the Home is evicted while the child runs", async () => {
    const stub = fresh()
    const coordinatorId = await makeProject(stub, "evict", { threadDepth: 2 })
    const parentId = started(await delegate(stub, coordinatorId, "evict-parent"))
    await settledAt(stub, parentId, 1)
    const childId = started(await delegate(stub, parentId, "evict-child"))
    await evictDurableObject(stub)
    await runDurableObjectAlarm(stub)
    await settledAt(stub, parentId, 2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await docOf(stub, parentId))?.run).toBe(2)
    await runInDurableObject(stub, async (home: Home) => {
      const texts = await userTexts(home, parentId)
      expect(texts.filter((text) => text.includes(`<thread id=\\"${childId}\\"`))).toHaveLength(1)
    })
    expect((await reportKeys(stub)).filter((key) => key.startsWith(`report:${parentId}:2`))).toHaveLength(1)
  })
})
