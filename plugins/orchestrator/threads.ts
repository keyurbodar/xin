import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, Draft } from "@earendil-works/chord"
import {
  configure,
  type ConversationId,
  defineTask,
  type DocumentReader,
  type Extension,
  type Harness,
  type ModelRef,
  type Task,
  type TaskRuntime,
  type ToolRegistration,
  type Tx,
  type Wake,
} from "@earendil-works/pi-durable"
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema"
import type { IntakeService } from "../../src/contracts/intake.ts"
import {
  capReason,
  ModelChoiceSchema,
  type Admission,
  type Feature,
  type ModelPick,
  type PickInput,
} from "../../src/contracts/models.ts"
import {
  SendModeSchema,
  type ReporterInput,
  type ThreadSettled,
  type ThreadSettledStatus,
} from "../../src/contracts/threads.ts"
import type { WatchdogService } from "../../src/contracts/watchdog.ts"
import type { ProjectId } from "../../src/ids.ts"
import { type Actor, defineOp, type Op, OpRejected } from "../../src/ops.ts"
import {
  ThreadDoc,
  defaultSpaceOf,
  ownerOf,
  RoleSchema,
  threadState,
  transition,
  type NewThread,
  type ThreadDocState,
  type ThreadRole,
  type ThreadState,
  type ThreadStatus,
} from "../../src/contracts/threaddoc.ts"
import { canUseThread, projectByRef, scopeOf } from "../../src/contracts/scope.ts"
import { detailOf, textOf } from "../../src/transcript.ts"
import { DEFAULT_THREAD_DEPTH, WorkspaceDoc, type SpaceState } from "../../src/contracts/workspace.ts"

const context = BACKGROUND_CONTEXT

const ANCHOR_KIND = "xin.anchor"
const REPORTER_KIND = "xin.reporter"

/**
 * Threads a space lists before its oldest finished ones drop out. Live threads (working or waiting) are never
 * dropped, and 100 is far more than one space's UI shows at once; the list bounds every create, list, boot,
 * watchdog and question read, all of which walk it.
 */
export const MAX_SPACE_THREADS = 100

export type CreateThreadArgs = {
  readonly projectId: ProjectId
  readonly spaceId?: string
  readonly archived?: boolean
  readonly parentId: ConversationId
  readonly title: string
  readonly role: ThreadRole
  readonly task: string
  readonly model: ModelRef
  /** Unset: the model's default level, or for a side thread the level it forks with. */
  readonly thinking?: ModelThinkingLevel
  readonly clientRequestId: string
  readonly requestId: string
  /** Above 1 for a thread another thread starts; absent: 1. */
  readonly depth?: number
  /** A side thread starts as a fork of this conversation at its newest entry instead of an empty one. */
  readonly forkFrom?: ConversationId
}

export type CreateOutcome =
  | { readonly kind: "created"; readonly threadId: number; readonly title: string }
  | { readonly kind: "existing"; readonly threadId: number; readonly title: string }
  | { readonly kind: "limit"; readonly live: readonly LiveThread[]; readonly limit: number }
  | { readonly kind: "rejected"; readonly reason: string }

type LiveThread = { readonly id: number; readonly title: string; readonly status: ThreadStatus }

export type ReportLanded = {
  readonly threadId: number
  readonly parentId: number
  readonly title: string
  readonly status: ReportStatus
  readonly text: string
}

type ReportStatus = ThreadSettledStatus
type ReporterCheckpoint =
  | { readonly phase: "deliver" }
  | {
      readonly phase: "report"
      readonly status: ReportStatus
      readonly text: string
    }
  | { readonly phase: "skip" }

export type ReporterTask = Task<ReporterInput, ReporterCheckpoint, null, object>
export type AnchorTask = Task<null, { readonly phase: "done" }, null, object>

const CHILD_TOOLS = [
  "delegate_task",
  "thread_create",
  "task_cancel",
  "thread_send",
  "thread_read",
  "thread_list",
  "task_status",
  "pending_request",
  "captain_notes",
] as const

/** What a thread below the project's `threadDepth` keeps, to start, steer, read and stop its own children. */
const NESTING_TOOLS: ReadonlySet<string> = new Set(["delegate_task", "task_status", "task_cancel", "thread_send"])

/**
 * The orchestration tools a thread at `depth` must not get, as handles for `configure`. The set only grows with depth,
 * so a child's tools stay a subset of its parent's.
 */
const childTools = (toolsNamed: ThreadDeps["toolsNamed"], depth: number, threadDepth: number) =>
  toolsNamed(depth < threadDepth ? CHILD_TOOLS.filter((tool) => !NESTING_TOOLS.has(tool)) : CHILD_TOOLS)

export type ThreadDeps = {
  readonly harness: Harness
  readonly toolsNamed: (names: readonly string[]) => readonly ToolRegistration[]
  arm(wake?: Wake): Promise<void>
  readonly intake: IntakeService
  readonly watchdog: WatchdogService
  threadRemovals(parent: ConversationId): readonly Extension[]
  settled(event: ThreadSettled): void
  disabled(ref: ModelRef): Promise<boolean>
  pick(input: PickInput): Promise<ModelPick>
  admit(feature: Feature): Promise<Admission>
  admitConversation(conversation: ConversationId): Promise<Admission>
}

const Anchor: AnchorTask = defineTask<null, { readonly phase: "done" }, null>({
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

const TERMINAL = { status: "terminal", outcome: { status: "completed", result: null } } as const

function reporterTask(deps: ThreadDeps, report: ReportFn): ReporterTask {
  return defineTask<ReporterInput, ReporterCheckpoint, null>({
    name: REPORTER_KIND,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, taskContext) => {
        const settled = await settle(deps, task.input, runtime, taskContext)
        const threadId = task.input.threadId as ConversationId
        const current = await runtime.snapshot(ThreadDoc, threadId, taskContext)
        const parentId = (current?.parentId ?? task.input.parentId) as ConversationId
        const nested = (await runtime.snapshot(ThreadDoc, parentId, taskContext)) !== undefined
        await runtime.commit(async (tx) => {
          const thread = await tx.doc(ThreadDoc, threadId)
          if (thread.status !== "working") {
            // A parent thread hears of a watchdog failure here; the watchdog itself only reaches coordinators.
            if (
              nested &&
              thread.status === "failed" &&
              (thread.run ?? 1) === task.input.run &&
              thread.result !== undefined
            )
              return {
                status: "running",
                checkpoint: { phase: "report", status: "failed", text: thread.result },
              } as const
            return { status: "running", checkpoint: { phase: "skip" } } as const
          }
          const next = transition(thread.status, eventOf(settled.status))
          if (next.kind === "ok") {
            thread.status = next.status
            delete thread.statusLine
          }
          thread.result = settled.text
          thread.beatAt = runtime.now()
          if (settled.status === "cancelled") delete thread.inbox
          // Reports that arrived during this run start the next one, whose answer is the one reported upward.
          else if (
            (thread.inbox?.length ?? 0) > 0 &&
            (await reopen(deps, tx, threadId, thread, [], `reopen:${threadId}:${(thread.run ?? 1) + 1}`, report)) !==
              undefined
          )
            return TERMINAL
          return {
            status: "running",
            checkpoint: { phase: "report", status: settled.status, text: settled.text },
          } as const
        }, taskContext)
      },
      report: async (task, runtime, taskContext) => {
        const checkpoint = task.state.checkpoint
        // A thread that joined or left a crew mid-run reports to the coordinator it has now.
        const current = await runtime.snapshot(ThreadDoc, task.input.threadId as ConversationId, taskContext)
        const parentId = (current?.parentId ?? task.input.parentId) as ConversationId
        const projectId = await projectIdOf(runtime, task.input.threadId, taskContext)
        if (projectId !== undefined)
          deps.settled({
            threadId: task.input.threadId,
            parentId,
            projectId,
            title: task.input.title,
            status: checkpoint.status,
            result: checkpoint.text,
          })
        const admission = await deps.admitConversation(parentId)
        if (admission.kind === "capped")
          console.warn(`threads: report of ${task.input.threadId} not delivered: ${capReason(admission)}`)
        const key = `report:${task.input.threadId}:${task.input.run}`
        if ((await runtime.snapshot(ThreadDoc, parentId, taskContext)) !== undefined) {
          const title = task.input.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
          const text = `<thread id="${task.input.threadId}" title="${title}" status="${checkpoint.status}">${checkpoint.text}</thread>`
          await runtime.commit(async (tx) => {
            if (admission.kind === "ok") await deliverToThread(deps, tx, parentId, { key, text }, report)
            return TERMINAL
          }, taskContext)
          return
        }
        const accepted =
          admission.kind === "ok" &&
          (await deps.intake.enqueue({
            target: parentId,
            commandId: key,
            kind: "report",
            threadId: String(task.input.threadId),
            title: task.input.title,
            status: checkpoint.status,
            text: checkpoint.text,
          }))
        if (accepted) await deps.arm()
        await runtime.commit(() => TERMINAL, taskContext)
      },
      skip: (_task, runtime, taskContext) => runtime.commit(() => TERMINAL, taskContext),
    },
    abort: (_task, runtime, taskContext) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
  })
}

type Post = { readonly key: string; readonly text: string }

/**
 * Hands a report to a parent thread inside the caller's commit, so a replay finds it done: a working or waiting parent
 * queues it for its next run, a finished one starts that run now, and a cancelled one drops it.
 */
async function deliverToThread(
  deps: ThreadDeps,
  tx: Tx,
  parentId: ConversationId,
  post: Post,
  report: ReportFn,
): Promise<void> {
  const parent = await tx.doc(ThreadDoc, parentId)
  const inbox = parent.inbox ?? []
  if (parent.status === "cancelled" || inbox.some((queued) => queued.key === post.key)) return
  if (parent.status === "working" || parent.status === "waiting") {
    parent.inbox = [...inbox, post]
    return
  }
  await reopen(deps, tx, parentId, parent, [post], `reopen:${parentId}:${(parent.run ?? 1) + 1}`, report)
}

/**
 * Starts run N+1 of a finished thread in the caller's commit, its brief the queued inbox followed by `posts`. Returns
 * that brief, or undefined when the thread cannot be reopened.
 */
async function reopen(
  deps: ThreadDeps,
  tx: Tx,
  threadId: ConversationId,
  thread: Draft<ThreadDocState>,
  posts: readonly Post[],
  requestId: string,
  report: ReportFn,
): Promise<string | undefined> {
  if (transition(thread.status, "thread_send").kind !== "ok" || thread.parentId === undefined) return undefined
  const workspace = await tx.doc(WorkspaceDoc)
  const project = workspace.projects[thread.projectId]
  if (project === undefined) return undefined
  const brief = [...(thread.inbox ?? []), ...posts].map((post) => post.text).join("\n\n")
  const run = (thread.run ?? 1) + 1
  const now = Date.now()
  thread.run = run
  thread.status = "working"
  delete thread.result
  delete thread.archived
  delete thread.inbox
  thread.beatAt = now
  thread.deadlineAt = now + project.settings.deadlineMs
  const parentId = thread.parentId as ConversationId
  await deps.watchdog.ensure(tx, ownerOf(workspace, thread, parentId))
  await report(tx, { threadId, parentId, title: thread.title, run, brief, requestId })
  return brief
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
    const reader = await deps.harness.conversation(input.threadId as ConversationId, taskContext)
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

async function projectIdOf(read: DocumentReader, threadId: number, run: Context): Promise<string | undefined> {
  const thread = await read.snapshot(ThreadDoc, threadId as ConversationId, run)
  if (thread !== undefined) return thread.projectId
  const workspace = await read.snapshot(WorkspaceDoc, run)
  for (const space of Object.values(workspace?.spaces ?? {})) {
    if (space.threadIds.includes(threadId)) return space.projectId
  }
  return undefined
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

async function addThread(tx: Tx, thread: NewThread): Promise<ThreadState> {
  const workspace = await tx.doc(WorkspaceDoc)
  const project = workspace.projects[thread.projectId]
  if (project === undefined) throw new OpRejected("bad_args", `no project ${thread.projectId}`)
  const spaceId = thread.spaceId ?? defaultSpaceOf(workspace, thread.projectId)
  const space = spaceId === undefined ? undefined : workspace.spaces[spaceId]
  if (spaceId === undefined || space === undefined)
    throw new OpRejected("bad_args", `project ${thread.projectId} has no space`)
  const status = thread.status ?? "working"
  if ((status === "completed" || status === "failed") && thread.result === undefined)
    throw new OpRejected("bad_args", `a ${status} thread needs a result`)
  const beatAt = thread.beatAt ?? Date.now()
  const deadlineAt = thread.deadlineAt ?? beatAt + project.settings.deadlineMs
  const doc = await tx.doc(ThreadDoc, thread.threadId)
  const value: ThreadDocState = {
    projectId: thread.projectId,
    spaceId,
    ...(thread.archived === true ? { archived: true } : {}),
    title: thread.title,
    role: thread.role ?? "thread",
    status,
    run: thread.run ?? 1,
    beatAt,
    deadlineAt,
    ...(thread.parentId === undefined ? {} : { parentId: thread.parentId }),
    ...(thread.depth === undefined || thread.depth === 1 ? {} : { depth: thread.depth }),
    ...(thread.anchorTaskId === undefined ? {} : { anchorTaskId: thread.anchorTaskId }),
    ...(thread.statusLine === undefined ? {} : { statusLine: thread.statusLine }),
    ...(thread.result === undefined ? {} : { result: thread.result }),
    ...(thread.clientRequestId === undefined ? {} : { clientRequestId: thread.clientRequestId }),
  }
  Object.assign(doc, value)
  if (!space.threadIds.includes(thread.threadId)) space.threadIds.push(thread.threadId)
  const state = threadState(value)
  if (state === undefined) throw new Error(`thread ${thread.threadId} does not satisfy xin.thread`)
  return state
}

/**
 * Keeps a space's thread list bounded. Past `MAX_SPACE_THREADS` ids the oldest finished ones drop out of the list, so
 * the UI, the watchdog and the question list stop walking every thread a space ever ran. A working or waiting thread
 * is never dropped, and an id whose document this project did not load is left alone. A pruned thread's own document
 * and conversation stay, so it can still act in its own scope.
 */
function trimThreadIds(
  space: SpaceState,
  docs: readonly { readonly id: number; readonly doc: Draft<ThreadDocState> }[],
): void {
  const overflow = space.threadIds.length - MAX_SPACE_THREADS
  if (overflow <= 0) return
  const status = new Map(docs.map(({ id, doc }) => [id, doc.status]))
  const dropped = new Set<number>()
  for (const id of [...space.threadIds].toSorted((left, right) => left - right)) {
    if (dropped.size >= overflow) break
    const found = status.get(id)
    if (found === undefined || found === "working" || found === "waiting") continue
    dropped.add(id)
  }
  if (dropped.size > 0) space.threadIds = space.threadIds.filter((id) => !dropped.has(id))
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
  report(tx: Tx, input: ReporterInput): Promise<void>
  createThread(tx: Tx, args: CreateThreadArgs): Promise<CreateOutcome>
  readonly ops: readonly Op[]
}

const sendKeyOf = (threadId: number, sendKey: string): string => `thread-send:${threadId}:${sendKey}`

type ReportFn = (tx: Tx, input: ReporterInput) => Promise<void>

async function sendToThread(
  deps: ThreadDeps,
  harness: Harness,
  args: SendArgs,
  report: ReportFn,
): Promise<SendOutcome> {
  const threadId = args.threadId as ConversationId
  const snapshot = await harness.snapshot(ThreadDoc, threadId, context)
  if (snapshot === undefined) return { kind: "rejected", reason: `no thread ${args.threadId}` }
  if (snapshot.status === "waiting") return { kind: "waiting" }
  if (snapshot.status === "working") return deliver(harness, threadId, args)
  const requestId = sendKeyOf(args.threadId, args.sendKey)
  const opened = await harness.commit(async (tx) => {
    const thread = await tx.doc(ThreadDoc, threadId)
    if (thread.status === "working") return { kind: "busy" as const }
    if (thread.status === "waiting") return { kind: "waiting" as const }
    const next = transition(thread.status, "thread_send")
    if (next.kind !== "ok") return { kind: "rejected" as const, reason: next.reason }
    if (thread.parentId === undefined)
      return { kind: "rejected" as const, reason: `thread ${args.threadId} has no parent` }
    const brief = await reopen(deps, tx, threadId, thread, [{ key: args.sendKey, text: args.text }], requestId, report)
    if (brief === undefined) return { kind: "rejected" as const, reason: `no project ${thread.projectId}` }
    return { kind: "opened" as const, run: thread.run ?? 1, brief }
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
      if (conversation !== undefined)
        await conversation.submit({ type: "input", content: opened.brief, requestId }, context)
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

function sendThreadOp(send: SendFn, deps: Pick<ThreadDeps, "disabled" | "admitConversation">): Op {
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
      const thread = await api.harness.conversation(args.threadId as ConversationId, context)
      const model = thread === undefined ? undefined : (await thread.agent(context)).model
      if (model !== undefined && (await deps.disabled(model)))
        throw new OpRejected("bad_args", `thread ${args.threadId} runs a disabled model; pick another first`)
      const admission = await deps.admitConversation(args.threadId as ConversationId)
      if (admission.kind === "capped") throw new OpRejected("forbidden", capReason(admission))
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
    const descendants = await liveDescendants(api.harness, doc.projectId, args.threadId)
    // The status moves before the abort, so each Reporter finds its thread no longer working and reports nothing; a
    // waiting thread has no run, so its document is the only thing to move.
    const status = await api.harness.commit(async (tx) => {
      let stopped: ThreadStatus | undefined
      for (const id of [args.threadId, ...descendants]) {
        const thread = await tx.doc(ThreadDoc, id as ConversationId)
        const next = transition(thread.status, "abort")
        if (next.kind === "ok") {
          thread.status = next.status
          delete thread.statusLine
          delete thread.inbox
        }
        stopped ??= thread.status
      }
      return stopped ?? "cancelled"
    }, context)
    for (const id of [args.threadId, ...descendants]) {
      const conversation = await api.harness.conversation(id as ConversationId, context)
      if (conversation !== undefined) await conversation.abort(context, { background: true })
    }
    return {
      threadId: args.threadId,
      stopped: true,
      status,
      ...(descendants.length === 0 ? {} : { descendants: [...descendants] }),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    }
  },
})

/** The working or waiting threads below `rootId`, nearest first: stopping a thread stops what it started. */
async function liveDescendants(harness: Harness, projectId: string, rootId: number): Promise<readonly number[]> {
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  const children = new Map<number, number[]>()
  const live = new Set<number>()
  for (const space of Object.values(workspace?.spaces ?? {})) {
    if (space.projectId !== projectId) continue
    for (const id of space.threadIds) {
      const doc = await harness.snapshot(ThreadDoc, id as ConversationId, context)
      if (doc?.parentId === undefined || (doc.depth ?? 1) === 1) continue
      children.set(doc.parentId, [...(children.get(doc.parentId) ?? []), id])
      if (doc.status === "working" || doc.status === "waiting") live.add(id)
    }
  }
  const found: number[] = []
  for (let frontier = [rootId]; frontier.length > 0;) {
    frontier = frontier.flatMap((id) => children.get(id) ?? [])
    found.push(...frontier.filter((id) => live.has(id)))
  }
  return found
}

async function denied(actor: Actor, harness: Harness, threadId: number): Promise<boolean> {
  if (actor.kind !== "agent") return false
  return !(await canUseThread(harness, actor.conversationId, threadId))
}

export function lifecycle(deps: ThreadDeps): Threads {
  const report: ReportFn = async (tx, input) => {
    const thread = await tx.doc(ThreadDoc, input.threadId as ConversationId)
    const workspace = await tx.doc(WorkspaceDoc)
    await tx.createTask(reporter, input, {
      ownership: { kind: "conversation" },
      conversationId: ownerOf(workspace, thread, input.parentId as ConversationId),
      background: true,
    })
  }
  const reporter = reporterTask(deps, report)
  const send = (harness: Harness, args: SendArgs): Promise<SendOutcome> => sendToThread(deps, harness, args, report)

  const createThread = async (tx: Tx, args: CreateThreadArgs): Promise<CreateOutcome> => {
    const workspace = await tx.doc(WorkspaceDoc)
    const project = workspace.projects[args.projectId]
    if (project === undefined) return { kind: "rejected", reason: `no project ${args.projectId}` }
    const spaceId = args.spaceId ?? defaultSpaceOf(workspace, args.projectId)
    const space = spaceId === undefined ? undefined : workspace.spaces[spaceId]
    if (spaceId === undefined || space === undefined || space.archived)
      return { kind: "rejected", reason: `project ${args.projectId} has no live space` }
    const docs: { readonly id: number; readonly doc: Draft<ThreadDocState> }[] = []
    for (const listedSpace of Object.values(workspace.spaces)) {
      if (listedSpace.projectId !== args.projectId) continue
      for (const id of listedSpace.threadIds) docs.push({ id, doc: await tx.doc(ThreadDoc, id as ConversationId) })
    }
    const existing = docs.find(
      ({ doc }) => doc.clientRequestId === args.clientRequestId && doc.parentId === args.parentId,
    )
    if (existing !== undefined) return { kind: "existing", threadId: existing.id, title: existing.doc.title }
    // A thread waiting on a question costs no model work, so it does not hold a live slot: only runs count.
    const live = docs.filter(({ doc }) => doc.status === "working")
    if (live.length >= project.settings.threadLimit) {
      return {
        kind: "limit",
        live: live.map(({ id, doc }) => ({ id, title: doc.title, status: doc.status })),
        limit: project.settings.threadLimit,
      }
    }
    const forkAt = args.forkFrom === undefined ? undefined : await tx.latestEntryId(args.forkFrom)
    const depth = args.depth ?? 1
    const owner = ownerOf(workspace, { depth, spaceId }, args.parentId)
    await deps.watchdog.ensure(tx, owner)
    const anchor = await tx.createTask(Anchor, null, {
      ownership: { kind: "conversation" },
      conversationId: owner,
      background: true,
    })
    const ownership = { kind: "task", taskId: anchor } as const
    const child =
      args.forkFrom === undefined || forkAt === undefined
        ? await tx.createConversation({ ownership })
        : await tx.forkConversation(args.forkFrom, forkAt, { ownership })
    await configure(tx, child.id, {
      model: args.model,
      ...(args.thinking === undefined ? {} : { thinkingLevel: args.thinking }),
      tools: {
        remove: [...childTools(deps.toolsNamed, depth, project.settings.threadDepth ?? DEFAULT_THREAD_DEPTH)],
      },
      extensions: { remove: [...deps.threadRemovals(args.parentId)] },
      instructions:
        args.forkFrom === undefined
          ? depth > 1
            ? `You are a thread named "${args.title}", started by another thread. Answer the brief; your last message is reported to that thread.`
            : `You are a thread named "${args.title}". Answer the brief; your last message is reported to the coordinator.`
          : `You are a thread named "${args.title}", a side thread forked from the conversation above. Work on the brief that follows; your last message is reported back to that conversation.`,
    })
    await addThread(tx, {
      projectId: args.projectId,
      spaceId,
      threadId: child.id,
      title: args.title,
      role: args.role,
      parentId: args.parentId,
      depth,
      anchorTaskId: String(anchor),
      run: 1,
      clientRequestId: args.clientRequestId,
    })
    trimThreadIds(space, docs)
    await report(tx, {
      threadId: child.id,
      parentId: args.parentId,
      title: args.title,
      run: 1,
      brief: args.task,
      requestId: args.requestId,
    })
    return { kind: "created", threadId: child.id, title: args.title }
  }

  const archiveThread = defineOp({
    name: "thread.archive",
    args: obj({ threadId: int({ minimum: 0 }), archived: opt(bool()) }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (await denied(api.actor, api.harness, args.threadId))
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      const threadId = args.threadId as ConversationId
      return api.harness.commit(async (tx) => {
        const thread = await tx.doc(ThreadDoc, threadId)
        const archived = args.archived ?? true
        if (archived) thread.archived = true
        else delete thread.archived
        return { threadId: args.threadId, archived }
      }, context)
    },
  })

  const createThreadOp = defineOp({
    name: "thread.create",
    args: obj({
      title: str({ minLength: 1, maxLength: 200 }),
      task: str({ minLength: 1 }),
      role: opt(RoleSchema),
      project: opt(str({ minLength: 1 })),
      spaceId: opt(str({ minLength: 1 })),
      target: opt(ModelChoiceSchema),
    }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      const callerId = api.actor.kind === "agent" ? api.actor.conversationId : undefined
      const scope = callerId === undefined ? undefined : await scopeOf(api.harness, callerId)
      if (api.actor.kind === "agent" && (scope === undefined || scope.kind !== "puck"))
        throw new OpRejected("forbidden", "only the owner or Puck can create a thread directly")
      const workspace = await api.harness.snapshot(WorkspaceDoc, context)
      if (workspace === undefined) throw new OpRejected("bad_args", "no workspace")
      const projectId =
        args.project === undefined ? undefined : (await projectByRef(api.harness, args.project))?.projectId
      if (args.project !== undefined && projectId === undefined)
        throw new OpRejected("bad_args", `no project "${args.project}"`)
      const spaceId = args.spaceId ?? (projectId === undefined ? undefined : defaultSpaceOf(workspace, projectId))
      if (spaceId === undefined) throw new OpRejected("bad_args", "thread.create needs a project or spaceId")
      const space = workspace.spaces[spaceId]
      if (space === undefined || space.archived) throw new OpRejected("bad_args", `no live space ${spaceId}`)
      if (projectId !== undefined && projectId !== space.projectId)
        throw new OpRejected("bad_args", `space ${spaceId} is not in project ${projectId}`)
      const project = workspace.projects[space.projectId]
      if (project === undefined || project.archived)
        throw new OpRejected("bad_args", `no live project ${space.projectId}`)
      const parentId =
        scope?.kind === "puck" && callerId !== undefined ? callerId : (space.coordinatorId as ConversationId)
      const picked = await deps.pick({
        creator: parentId,
        role: args.role ?? "thread",
        ...(project.settings.models === undefined ? {} : { project: project.settings.models }),
        ...(args.target === undefined ? {} : { choice: args.target }),
      })
      if (picked.kind === "refused") throw new OpRejected("bad_args", picked.reason)
      const admission = await deps.admit("thread")
      if (admission.kind === "capped") throw new OpRejected("forbidden", capReason(admission))
      const requestId = `thread-create:${api.commandId}`
      const created = await api.harness.commit(
        (tx) =>
          createThread(tx, {
            projectId: space.projectId as ProjectId,
            spaceId,
            parentId,
            title: args.title,
            role: args.role ?? "thread",
            task: args.task,
            model: picked.model,
            ...(picked.thinking === undefined ? {} : { thinking: picked.thinking }),
            clientRequestId: requestId,
            requestId,
          }),
        context,
      )
      switch (created.kind) {
        case "created":
        case "existing":
          return {
            threadId: created.threadId,
            title: created.title,
            projectId: space.projectId,
            spaceId,
            ...(created.kind === "existing" ? { replayed: true } : {}),
          }
        case "rejected":
          throw new OpRejected("bad_args", created.reason)
        case "limit":
          throw new OpRejected("busy", `limit_reached: ${created.live.length} live threads of ${created.limit}`)
      }
    },
  })

  const sideThreadOp = defineOp({
    name: "thread.side",
    args: obj({
      conv: int({ minimum: 0 }),
      title: str({ minLength: 1, maxLength: 200 }),
      task: str({ minLength: 1 }),
      target: opt(ModelChoiceSchema),
    }),
    actors: ["owner"],
    run: async (api, args) => {
      const parentId = args.conv as ConversationId
      const scope = await scopeOf(api.harness, parentId)
      if (scope?.kind !== "space")
        throw new OpRejected("bad_args", `conversation ${args.conv} is not a space coordinator or Captain`)
      if (scope.space.archived) throw new OpRejected("bad_args", `space ${scope.spaceId} is archived`)
      const picked = await deps.pick({
        creator: parentId,
        role: "thread",
        ...(scope.project?.settings.models === undefined ? {} : { project: scope.project.settings.models }),
        ...(args.target === undefined ? {} : { choice: args.target }),
      })
      if (picked.kind === "refused") throw new OpRejected("bad_args", picked.reason)
      const admission = await deps.admit("thread")
      if (admission.kind === "capped") throw new OpRejected("forbidden", capReason(admission))
      const requestId = `thread-side:${api.commandId}`
      const created = await api.harness.commit(
        (tx) =>
          createThread(tx, {
            projectId: scope.projectId as ProjectId,
            spaceId: scope.spaceId,
            parentId,
            title: args.title,
            role: "thread",
            task: args.task,
            model: picked.model,
            ...(picked.thinking === undefined ? {} : { thinking: picked.thinking }),
            clientRequestId: requestId,
            requestId,
            forkFrom: parentId,
          }),
        context,
      )
      switch (created.kind) {
        case "created":
        case "existing":
          return {
            threadId: created.threadId,
            title: created.title,
            parentId: args.conv,
            projectId: scope.projectId,
            spaceId: scope.spaceId,
            ...(created.kind === "existing" ? { replayed: true } : {}),
          }
        case "rejected":
          throw new OpRejected("bad_args", created.reason)
        case "limit":
          throw new OpRejected("busy", `limit_reached: ${created.live.length} live threads of ${created.limit}`)
      }
    },
  })

  return {
    anchor: Anchor,
    reporter,
    report,
    createThread,
    ops: [sendThreadOp(send, deps), stopThread, archiveThread, createThreadOp, sideThreadOp],
  }
}
