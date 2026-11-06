import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, Draft } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import {
  configure,
  type ConversationId,
  defineTask,
  type DocumentReader,
  type Harness,
  type ModelRef,
  type Task,
  type TaskRuntime,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable"
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import { enqueue } from "./gateway.ts"
import type { ProjectId } from "./ids.ts"
import type { ModuleDeps } from "./module.ts"
import { type Actor, defineOp, type Op, OpRejected } from "./ops.ts"
import {
  addThread,
  ThreadDoc,
  threadInScope,
  transition,
  type ThreadDocState,
  type ThreadRole,
  type ThreadStatus,
} from "./threaddoc.ts"
import { detailOf, textOf } from "./transcript.ts"
import { WorkspaceDoc } from "./workspace.ts"

const context = BACKGROUND_CONTEXT
const SendModeSchema = oneOf(["steer", "queue"] as const)

export const ANCHOR_KIND = "xin.anchor"
export const REPORTER_KIND = "xin.reporter"

export type ReportLanded = {
  readonly threadId: number
  readonly parentId: number
  readonly title: string
  readonly status: ReportStatus
  readonly text: string
}

export type ReporterInput = {
  readonly threadId: number
  readonly parentId: number
  readonly title: string
  readonly run: number
  readonly brief: string
  readonly requestId: string
}

type ReportStatus = Extract<ThreadStatus, "completed" | "failed" | "cancelled">
type ReporterCheckpoint =
  | { readonly phase: "deliver" }
  | {
      readonly phase: "report"
      readonly status: ReportStatus
      readonly text: string
    }

export type ReporterTask = Task<ReporterInput, ReporterCheckpoint, null, object>
export type AnchorTask = Task<null, { readonly phase: "done" }, null, object>

export type ThreadDeps = {
  readonly db: SqliteDatabase
  arm(): Promise<void>
  harness(): Harness
}

export const Anchor: AnchorTask = defineTask<null, { readonly phase: "done" }, null>({
  name: ANCHOR_KIND,
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, runtime, taskContext) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
  },
  abort: (_task, runtime, taskContext) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
})

export function reporterTask(deps: ThreadDeps): ReporterTask {
  return defineTask<ReporterInput, ReporterCheckpoint, null>({
    name: REPORTER_KIND,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, taskContext) => {
        const settled = await settle(deps, task.input, runtime, taskContext)
        await runtime.commit(async (tx) => {
          const thread = await tx.doc(ThreadDoc, task.input.threadId as ConversationId)
          if (thread.status === "working") {
            const next = transition(thread.status, eventOf(settled.status))
            if (next.kind === "ok") thread.status = next.status
          }
          thread.result = settled.text
          thread.beatAt = runtime.now()
          return {
            status: "running",
            checkpoint: { phase: "report", status: settled.status, text: settled.text },
          } as const
        }, taskContext)
      },
      report: async (task, runtime, taskContext) => {
        const checkpoint = task.state.checkpoint
        const accepted = await enqueue(
          deps.db,
          {
            target: task.input.parentId as ConversationId,
            commandId: `report:${task.input.threadId}:${task.input.run}`,
            kind: "report",
            threadId: String(task.input.threadId),
            title: task.input.title,
            status: checkpoint.status,
            text: checkpoint.text,
          },
          runtime.now(),
        )
        if (accepted) await deps.arm()
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          taskContext,
        )
      },
    },
    abort: (_task, runtime, taskContext) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
  })
}

async function settle(
  deps: ThreadDeps,
  input: ReporterInput,
  runtime: TaskRuntime<ReporterInput, ReporterCheckpoint, null, object>,
  taskContext: Context,
): Promise<{ readonly status: ReportStatus; readonly text: string }> {
  const conversation = await runtime.conversation(input.threadId as ConversationId, taskContext)
  if (conversation === undefined) return { status: "failed", text: "failed: the thread conversation is gone" }
  const submission = await conversation.submit(
    { type: "input", content: input.brief, requestId: input.requestId },
    taskContext,
  )
  const settled = await submission.wait(taskContext)
  if (settled.status === "done") {
    if (settled.type !== "input") return { status: "completed", text: "(no text)" }
    const reader = await deps.harness().conversation(input.threadId as ConversationId, taskContext)
    const page = await reader?.entries(
      { minEntryId: settled.answer, maxEntryId: settled.answer, order: "ascending" },
      1,
      undefined,
      taskContext,
    )
    return { status: "completed", text: textOf(page?.items[0]) || "(no text)" }
  }
  if (settled.reason === "aborted") {
    return {
      status: "cancelled",
      text: settled.detail === undefined ? "cancelled" : `cancelled: ${detailOf(settled.detail)}`,
    }
  }
  return {
    status: "failed",
    text: settled.detail === undefined ? `failed: ${settled.reason}` : `failed: ${detailOf(settled.detail)}`,
  }
}

function eventOf(status: ReportStatus): "done" | "unanswered" | "abort" {
  switch (status) {
    case "completed":
      return "done"
    case "cancelled":
      return "abort"
    case "failed":
      return "unanswered"
  }
}

type LiveThread = { readonly id: number; readonly title: string; readonly status: ThreadStatus }

export type CreateOutcome =
  | { readonly kind: "created"; readonly threadId: number; readonly title: string }
  | { readonly kind: "existing"; readonly threadId: number; readonly title: string }
  | { readonly kind: "limit"; readonly live: readonly LiveThread[]; readonly limit: number }
  | { readonly kind: "rejected"; readonly reason: string }

export type CreateThreadArgs = {
  readonly projectId: ProjectId
  readonly parentId: ConversationId
  readonly title: string
  readonly role: ThreadRole
  readonly task: string
  readonly model: ModelRef
  readonly clientRequestId: string
  readonly requestId: string
  readonly removeTools: readonly ToolRegistration[]
}

export type SendArgs = {
  readonly threadId: number
  readonly text: string
  readonly mode: "steer" | "queue"
  readonly sendKey: string
}

export type SendOutcome =
  | { readonly kind: "sent"; readonly run?: number; readonly note: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "rejected"; readonly reason: string }

type SendFn = (harness: Harness, args: SendArgs) => Promise<SendOutcome>

export type Threads = {
  readonly anchor: AnchorTask
  readonly reporter: ReporterTask
  createThread(tx: Tx, args: CreateThreadArgs): Promise<CreateOutcome>
  readonly ops: readonly Op[]
}

const sendKeyOf = (threadId: number, sendKey: string): string => `thread-send:${threadId}:${sendKey}`

async function sendToThread(harness: Harness, args: SendArgs, reporter: ReporterTask): Promise<SendOutcome> {
  const threadId = args.threadId as ConversationId
  const snapshot = await harness.snapshot(ThreadDoc, threadId, context)
  if (snapshot === undefined) return { kind: "rejected", reason: `no thread ${args.threadId}` }
  if (snapshot.status === "waiting") return { kind: "waiting" }
  if (snapshot.status === "working") return deliver(harness, threadId, args)
  const opened = await harness.commit(async (tx) => {
    const thread = await tx.doc(ThreadDoc, threadId)
    if (thread.status === "working") return { kind: "busy" as const }
    if (thread.status === "waiting") return { kind: "waiting" as const }
    const next = transition(thread.status, "thread_send")
    if (next.kind !== "ok") return { kind: "rejected" as const, reason: next.reason }
    if (thread.parentId === undefined)
      return { kind: "rejected" as const, reason: `thread ${args.threadId} has no parent` }
    const parentId = thread.parentId as ConversationId
    const workspace = await tx.doc(WorkspaceDoc)
    const project = workspace.projects[thread.projectId]
    if (project === undefined) return { kind: "rejected" as const, reason: `no project ${thread.projectId}` }
    const run = (thread.run ?? 1) + 1
    const now = Date.now()
    thread.run = run
    thread.status = "working"
    delete thread.result
    thread.beatAt = now
    thread.deadlineAt = now + project.settings.deadlineMs
    await tx.createTask(
      reporter,
      {
        threadId: args.threadId,
        parentId,
        title: thread.title,
        run,
        brief: args.text,
        requestId: sendKeyOf(args.threadId, args.sendKey),
      },
      { ownership: { kind: "conversation" }, conversationId: parentId, background: true },
    )
    return { kind: "opened" as const, run }
  }, context)
  switch (opened.kind) {
    case "rejected":
      return { kind: "rejected", reason: opened.reason }
    case "waiting":
      return { kind: "waiting" }
    case "busy":
      return deliver(harness, threadId, args)
    case "opened": {
      const conversation = await harness.conversation(threadId, context)
      if (conversation !== undefined) {
        await conversation.submit(
          {
            type: "input",
            content: args.text,
            requestId: sendKeyOf(args.threadId, args.sendKey),
          },
          context,
        )
      }
      return { kind: "sent", run: opened.run, note: `Started run ${opened.run}. Its result will arrive as a report.` }
    }
  }
}

async function deliver(harness: Harness, threadId: ConversationId, args: SendArgs): Promise<SendOutcome> {
  const conversation = await harness.conversation(threadId, context)
  if (conversation === undefined) return { kind: "rejected", reason: `conversation ${args.threadId} is gone` }
  await conversation.submit(
    {
      type: "input",
      content: args.text,
      requestId: sendKeyOf(args.threadId, args.sendKey),
      whenBusy: args.mode === "steer" ? "steer" : "followUp",
    },
    context,
  )
  return { kind: "sent", note: "The thread is running; the message was sent to it." }
}

function sendThreadOp(send: SendFn): Op {
  return defineOp({
    name: "thread.send",
    args: obj({
      threadId: int({ minimum: 0 }),
      text: str({ minLength: 1 }),
      mode: SendModeSchema,
    }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (await denied(api.actor, api.harness, args.threadId))
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      const outcome = await send(api.harness, { ...args, sendKey: api.commandId })
      switch (outcome.kind) {
        case "rejected":
          throw new OpRejected("bad_args", outcome.reason)
        case "waiting":
          throw new OpRejected("bad_args", `thread ${args.threadId} is waiting for an answer`)
        case "sent":
          return {
            threadId: args.threadId,
            sent: true,
            note: outcome.note,
            ...(outcome.run === undefined ? {} : { run: outcome.run }),
          }
      }
    },
  })
}

const stopThread = defineOp({
  name: "thread.stop",
  args: obj({ threadId: int({ minimum: 0 }), reason: opt(str({ maxLength: 500 })) }),
  actors: ["owner", "agent"],
  run: async (api, args) => {
    if (await denied(api.actor, api.harness, args.threadId))
      throw new OpRejected("bad_args", `no thread ${args.threadId}`)
    const threadId = args.threadId as ConversationId
    const doc = await api.harness.snapshot(ThreadDoc, threadId, context)
    if (doc === undefined) throw new OpRejected("bad_args", `no thread ${args.threadId}`)
    const conversation = await api.harness.conversation(threadId, context)
    if (conversation !== undefined) await conversation.abort(context, { background: true })
    return {
      threadId: args.threadId,
      stopped: true,
      status: doc.status,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    }
  },
})

async function denied(actor: Actor, read: DocumentReader, threadId: number): Promise<boolean> {
  if (actor.kind !== "agent") return false
  return (await threadInScope(read, actor.conversationId, threadId)) === undefined
}

export function lifecycle(deps: ModuleDeps): Threads {
  const reporter = reporterTask({ db: deps.db, arm: () => deps.arm(), harness: () => deps.harness() })
  const send = (harness: Harness, args: SendArgs): Promise<SendOutcome> => sendToThread(harness, args, reporter)

  const createThread = async (tx: Tx, args: CreateThreadArgs): Promise<CreateOutcome> => {
    const workspace = await tx.doc(WorkspaceDoc)
    const project = workspace.projects[args.projectId]
    if (project === undefined) return { kind: "rejected", reason: `no project ${args.projectId}` }
    const docs: { readonly id: number; readonly doc: Draft<ThreadDocState> }[] = []
    for (const id of project.threadIds) docs.push({ id, doc: await tx.doc(ThreadDoc, id as ConversationId) })
    const existing = docs.find(
      ({ doc }) => doc.clientRequestId === args.clientRequestId && doc.parentId === args.parentId,
    )
    if (existing !== undefined) return { kind: "existing", threadId: existing.id, title: existing.doc.title }
    const live = docs.filter(({ doc }) => doc.status === "working" || doc.status === "waiting")
    if (live.length >= project.settings.threadLimit) {
      return {
        kind: "limit",
        live: live.map(({ id, doc }) => ({ id, title: doc.title, status: doc.status })),
        limit: project.settings.threadLimit,
      }
    }
    const anchor = await tx.createTask(Anchor, null, {
      ownership: { kind: "conversation" },
      conversationId: args.parentId,
      background: true,
    })
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } })
    await configure(tx, child.id, {
      model: args.model,
      tools: { remove: [...args.removeTools] },
      instructions: `You are a thread named "${args.title}". Answer the brief; your last message is reported to the coordinator.`,
    })
    await addThread(tx, {
      projectId: args.projectId,
      threadId: child.id,
      title: args.title,
      role: args.role,
      parentId: args.parentId,
      anchorTaskId: String(anchor),
      run: 1,
      clientRequestId: args.clientRequestId,
    })
    await tx.createTask(
      reporter,
      {
        threadId: child.id,
        parentId: args.parentId,
        title: args.title,
        run: 1,
        brief: args.task,
        requestId: args.requestId,
      },
      { ownership: { kind: "conversation" }, conversationId: args.parentId, background: true },
    )
    return { kind: "created", threadId: child.id, title: args.title }
  }

  return { anchor: Anchor, reporter, createThread, ops: [sendThreadOp(send), stopThread] }
}
