import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { LiveDoc } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M5_MODEL } from "../../test/plugins/m5.ts"
import { cmd, addThreads, connect, eventually, fresh, owner } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { ThreadDoc, threadInScope } from "../../src/contracts/threaddoc.ts"
import { MAX_SPACE_THREADS } from "./threads.ts"
import { threadIdsOfProject, WorkspaceDoc } from "../../src/contracts/workspace.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type ThreadRow = { readonly id: number; readonly title: string; readonly status: string }
type Batch = { readonly rows: readonly unknown[]; readonly text: string }
type ReportRow = { readonly commandId: string; readonly status: string }

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number; spaceId: string }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number; spaceId: string }
}

async function chooseModel(stub: Stub, coordinatorId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M5_MODEL }, context)
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

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const reportCount = async (home: Home): Promise<number> =>
  (await home.intake()).filter((item) => item.kind === "report").length

const reports = async (home: Home): Promise<ReportRow[]> =>
  (await home.intake())
    .filter((item) => item.kind === "report")
    .map((item) => ({ commandId: item.commandId, status: item.status }))

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

const batches = async (home: Home, coordinatorId: number): Promise<Batch[]> => {
  const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 200, undefined, context)
  return page.items
    .filter((entry) => entry.kind === "xin.batch")
    .map((entry) => ({
      rows: Array.isArray(entry.data) ? entry.data : [],
      text: (entry.model ?? []).map(textOf).join("\n"),
    }))
}

const toolResultTexts = async (home: Home, coordinatorId: number): Promise<string[]> => {
  const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "toolResult").map(textOf),
  )
}

const idle = async (home: Home, coordinatorId: number): Promise<boolean> =>
  (await home.harness.snapshot(LiveDoc, coordinatorId as ConversationId, context))?.run === undefined

const answerTexts = async (home: Home, conversationId: number): Promise<string[]> => {
  const conversation = await home.harness.conversation(conversationId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role === "assistant")
      .map(textOf)
      .filter((text) => text !== ""),
  )
}

const isReportRow = (row: unknown): boolean =>
  typeof row === "object" && row !== null && "kind" in row && row.kind === "report"

const textsFor = async (home: Home, conversationId: number, role: "user" | "assistant"): Promise<string[]> => {
  const conversation = await home.harness.conversation(conversationId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role === role)
      .map(textOf)
      .filter((text) => text !== ""),
  )
}

const read = <T>(stub: Stub, work: (home: Home) => Promise<T>): Promise<T> => runInDurableObject(stub, work)

describe("orchestrator", () => {
  it("starts a thread in the space that asked", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "spaces")
    const second = await cmd(stub, "space-2", "space.create", { projectId: project.id, name: "Second" })
    expect(second.ok, JSON.stringify(second)).toBe(true)
    const space = second.result as { id: string; coordinatorId: number }
    await chooseModel(stub, space.coordinatorId)
    await send(stub, "space-1", space.coordinatorId, "delegate one")
    await fireNow(stub)

    await eventually(stub, async (home: Home) => {
      const workspace = await home.harness.snapshot(WorkspaceDoc, context)
      return (workspace?.spaces[space.id]?.threadIds.length ?? 0) === 1
    })
    const workspace = await read(stub, (home) => home.harness.snapshot(WorkspaceDoc, context))
    expect(workspace?.spaces[space.id]?.threadIds).toHaveLength(1)
    expect(workspace?.spaces[project.spaceId]?.threadIds).toHaveLength(0)
  })

  it("lets a thread see itself but not its siblings", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "scope")
    const [alpha, beta] = await addThreads(stub, project.id, ["alpha", "beta"])
    if (alpha === undefined || beta === undefined) throw new Error("no threads")

    const [self, sibling, coordinator] = await read(stub, (home: Home) =>
      Promise.all([
        threadInScope(home.harness, alpha.id, alpha.id),
        threadInScope(home.harness, alpha.id, beta.id),
        threadInScope(home.harness, project.coordinatorId as ConversationId, beta.id),
      ]),
    )
    expect(self).toBeDefined()
    expect(sibling).toBeUndefined()
    expect(coordinator).toBeDefined()
  })

  it("turns eight finished threads into exactly one coordinator turn", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "eight")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "eight-1", project.coordinatorId, "delegate 8")
    await fireNow(stub)

    await eventually(stub, (home: Home) => reportCount(home).then((count) => count === 8))
    await eventually(stub, (home: Home) => idle(home, project.coordinatorId))
    await fireNow(stub)
    await eventually(stub, async (home: Home) =>
      (await batches(home, project.coordinatorId)).some((batch) => batch.rows.length === 8),
    )

    const reportBatches = (await read(stub, (home) => batches(home, project.coordinatorId))).filter(
      (batch) => batch.rows.length > 0 && batch.rows.every(isReportRow),
    )
    expect(reportBatches).toHaveLength(1)
    expect(reportBatches[0]?.rows).toHaveLength(8)
    expect(reportBatches[0]?.text.match(/<thread /g) ?? []).toHaveLength(8)
    expect(await read(stub, (home) => threads(home, project.id))).toHaveLength(8)
  }, 20_000)

  it("leaves a running thread alive when the coordinator stops, and it still reports", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "stop")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "stop-1", project.coordinatorId, "delegate stop")
    await fireNow(stub)

    await eventually(stub, async (home: Home) => {
      const found = await threads(home, project.id)
      const id = found[0]?.id
      if (id === undefined) return false
      const live = await home.harness.snapshot(LiveDoc, id as ConversationId, context)
      return live?.run !== undefined && live.generation !== undefined
    })
    const stopped = await cmd(stub, "stop-conv", "conv.stop", { conv: project.coordinatorId })
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true)
    expect((await read(stub, (home) => threads(home, project.id)))[0]?.status).toBe("working")

    await eventually(stub, (home: Home) => reportCount(home).then((count) => count === 1))
    expect((await read(stub, (home) => threads(home, project.id)))[0]?.status).toBe("completed")
  }, 20_000)

  it("creates one thread when delegate_task replays the same clientRequestId", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "replay")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "replay-1", project.coordinatorId, "delegate twice")
    await fireNow(stub)

    await eventually(stub, (home: Home) => reportCount(home).then((count) => count === 1))
    expect(await read(stub, (home) => threads(home, project.id))).toHaveLength(1)
    expect(await read(stub, reports)).toHaveLength(1)
  }, 20_000)

  it("re-opens a completed thread as run 2 with a second report", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "again")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "again-1", project.coordinatorId, "delegate one")
    await fireNow(stub)

    await eventually(stub, (home: Home) => reportCount(home).then((count) => count === 1))
    const thread = (await read(stub, (home) => threads(home, project.id)))[0]
    if (thread === undefined) throw new Error("no thread")
    expect(thread.status).toBe("completed")
    await fireNow(stub)

    const reopened = await cmd(stub, "again-2", "thread.send", {
      threadId: thread.id,
      text: "again please",
      mode: "steer",
    })
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true)
    expect(
      (await read(stub, (home) => home.harness.snapshot(ThreadDoc, thread.id as ConversationId, context)))?.run,
    ).toBe(2)
    await eventually(stub, async (home: Home) =>
      (await home.intake()).some((item) => item.commandId === `report:${thread.id}:2`),
    )
    expect((await read(stub, reports)).map((row) => row.commandId)).toContain(`report:${thread.id}:2`)
    await eventually(stub, async (home: Home) => (await answerTexts(home, thread.id)).length === 2)
  }, 20_000)

  it("keeps a space's thread list bounded and never drops a live thread", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "threads-cap")
    await chooseModel(stub, project.coordinatorId)
    const [live] = await addThreads(stub, project.id, ["live"], "/projects/threads-cap")
    if (live === undefined) throw new Error("no live thread")
    const finished = await runInDurableObject(stub, async (home: Home) => {
      // One commit makes the conversations, the next writes their documents: a pi transaction cannot read after a write.
      const ids = await home.harness.commit(async (tx) => {
        const created: number[] = []
        for (let index = 0; index < MAX_SPACE_THREADS + 20; index += 1) {
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } })
          created.push(conversation.id)
        }
        return created
      }, context)
      await home.harness.commit(async (tx) => {
        const docs = await Promise.all(ids.map((id) => tx.doc(ThreadDoc, id as ConversationId)))
        const workspace = await tx.doc(WorkspaceDoc)
        const space = workspace.spaces[project.spaceId]
        if (space === undefined) throw new Error("no space")
        const now = Date.now()
        for (const [index, doc] of docs.entries())
          Object.assign(doc, {
            projectId: project.id,
            spaceId: project.spaceId,
            title: `finished ${index}`,
            role: "thread",
            status: "completed",
            run: 1,
            beatAt: now,
            deadlineAt: now + 60_000,
            result: "done",
          })
        for (const id of ids) space.threadIds.push(id)
      }, context)
      return ids
    })

    const created = await cmd(stub, "threads-cap-create", "thread.create", {
      title: "new",
      task: "do the work",
      project: project.id,
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const listed = await read(
      stub,
      async (home) => (await home.harness.snapshot(WorkspaceDoc, context))?.spaces[project.spaceId]?.threadIds ?? [],
    )
    expect(listed).toHaveLength(MAX_SPACE_THREADS)
    expect(listed).toContain(live.id)
    expect(listed).toContain((created.result as { threadId: number }).threadId)
    expect(listed).not.toContain(finished[0])
    expect(listed).toContain(finished.at(-1))
  }, 30_000)

  it("rejects a delegate over threadLimit with limit_reached", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "limit")
    await chooseModel(stub, project.coordinatorId)
    const updated = await cmd(stub, "limit-settings", "project.update", {
      id: project.id,
      settings: { threadLimit: 1 },
    })
    expect(updated.ok, JSON.stringify(updated)).toBe(true)
    await send(stub, "limit-1", project.coordinatorId, "delegate limit")
    await fireNow(stub)

    await eventually(stub, async (home: Home) => (await threads(home, project.id)).length === 1)
    await eventually(stub, async (home: Home) =>
      (await toolResultTexts(home, project.coordinatorId)).some((text) => text.includes("limit_reached")),
    )
    expect(await read(stub, (home) => threads(home, project.id))).toHaveLength(1)
  }, 20_000)

  it("commits an xin.error entry when the coordinator has no model", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "nomodel")
    await send(stub, "nomodel-1", project.coordinatorId, "hello")
    await fireNow(stub)

    await eventually(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
      if (conversation === undefined) return false
      const page = await conversation.entries({ order: "descending" }, 20, undefined, context)
      return page.items.some((entry) => entry.kind === "xin.error")
    })
    const entry = await read(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
      if (conversation === undefined) return undefined
      const page = await conversation.entries({ order: "descending" }, 20, undefined, context)
      return page.items.find((candidate) => candidate.kind === "xin.error")
    })
    expect(entry?.data).toMatchObject({ reason: "no_model" })
    expect(JSON.stringify(entry?.data)).toContain("Pick a model")
  }, 20_000)

  it("reports the thread's text when the reply also carries a thinking part", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "thinking")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "thinking-1", project.coordinatorId, "delegate thinking")
    await fireNow(stub)

    await eventually(stub, (home: Home) => reportCount(home).then((count) => count === 1))
    const body = await read(
      stub,
      async (home: Home) => (await home.intake()).find((item) => item.kind === "report")?.body,
    )
    const value: unknown = JSON.parse(body ?? "{}")
    const text = typeof value === "object" && value !== null ? Reflect.get(value, "text") : undefined
    expect(text).toBe("thread answer: think about it")
  }, 20_000)

  it("pushes the home stream when a delegated thread appears", async () => {
    const stub = owner()
    const project = await makeProject(stub, "home-push")
    await chooseModel(stub, project.coordinatorId)

    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    await socket.next((frame) => frame.t === "snap" && frame.stream === "home")

    await send(stub, "home-push-1", project.coordinatorId, "delegate one")
    await fireNow(stub)

    const frame = await socket.next(
      (candidate) =>
        candidate.t === "snap" && candidate.stream === "home" && JSON.stringify(candidate.value).includes("Thread 1"),
    )
    expect(JSON.stringify(frame.value)).toContain("Thread 1")
    socket.close()
  }, 20_000)

  it("delivers a replayed thread.send once when the receipt is lost", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "send-replay")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "send-replay-1", project.coordinatorId, "delegate one")
    await fireNow(stub)

    await eventually(stub, (home: Home) => reportCount(home).then((count) => count === 1))
    const thread = (await read(stub, (home) => threads(home, project.id)))[0]
    if (thread === undefined) throw new Error("no thread")
    await fireNow(stub)

    const args = { threadId: thread.id, text: "very slow again", mode: "steer" }
    const first = await cmd(stub, "send-replay-open", "thread.send", args)
    expect(first.ok, JSON.stringify(first)).toBe(true)
    await read(stub, (home: Home) => home.db.run("DELETE FROM receipts WHERE command_id = ?", "send-replay-open"))
    await evictDurableObject(stub)

    const replayed = await cmd(stub, "send-replay-open", "thread.send", args)
    expect(replayed.ok, JSON.stringify(replayed)).toBe(true)
    const delivered = await read(stub, (home: Home) => textsFor(home, thread.id, "user"))
    expect(delivered.filter((text) => text === args.text)).toHaveLength(1)
  }, 25_000)
})
