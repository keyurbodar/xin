import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { beforeEach, describe, expect, it } from "vitest"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { resetAlt, THINKING_MODEL, WIDE_MODEL } from "../../test/plugins/m3.ts"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Choice = { readonly model?: { provider: string; modelId: string } }

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

const delegate = (stub: Stub, callerId: number, key: string, choice?: Choice) =>
  runInDurableObject(stub, (home: Home) =>
    home.loader.ctx.threads.delegate(
      { conversationId: callerId as ConversationId, taskId: `task-${key}` },
      { task: "say hi", title: key, mode: "async", clientRequestId: key, ...(choice === undefined ? {} : { choice }) },
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
    await eventually(
      stub,
      async (home) =>
        (await home.harness.snapshot(ThreadDoc, parentId as ConversationId, context))?.status === "completed",
    )

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

    await eventually(stub, async (home) => {
      const doc = await home.harness.snapshot(ThreadDoc, parentId as ConversationId, context)
      return doc?.run === 2 && doc.status === "completed"
    })
    await runInDurableObject(stub, async (home: Home) => {
      const texts = await userTexts(home, parentId)
      expect(texts.some((text) => text.includes(`<thread id=\\"${childId}\\"`))).toBe(true)
      const reports = (await home.intake()).filter((item) => item.kind === "report")
      expect(reports).toEqual(
        expect.arrayContaining([expect.objectContaining({ commandId: `report:${parentId}:2`, target: coordinatorId })]),
      )
      expect(reports.some((item) => item.commandId === `report:${childId}:1`)).toBe(false)
    })
  })
})
