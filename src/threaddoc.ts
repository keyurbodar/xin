import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import { defineDoc, type ConversationId, type DocumentReader, type Harness, type Tx } from "@earendil-works/pi-durable"
import { compile, int, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema"
import type { ProjectId, ThreadId } from "./ids.ts"
import { OpRejected } from "./ops.ts"
import { WorkspaceDoc, type ProjectState } from "./workspace.ts"

const context = BACKGROUND_CONTEXT

const ROLES = ["chat", "thread", "utility"] as const
const STATUSES = ["working", "waiting", "completed", "failed", "cancelled"] as const

export type ThreadRole = (typeof ROLES)[number]
export type ThreadStatus = (typeof STATUSES)[number]

const ThreadSchema = obj({
  projectId: str(),
  parentId: opt(int({ minimum: 0 })),
  anchorTaskId: opt(str()),
  title: str(),
  role: oneOf(ROLES),
  status: oneOf(STATUSES),
  run: opt(int({ minimum: 1 })),
  statusLine: opt(str()),
  beatAt: opt(num()),
  deadlineAt: opt(num()),
  result: opt(str()),
  clientRequestId: opt(str()),
})

export type ThreadDocState = Static<typeof ThreadSchema>

const parseThread = compile(ThreadSchema)

export const ThreadDoc = defineDoc<ThreadDocState>({
  kind: "xin.thread",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ projectId: "", title: "", role: "thread", status: "working", run: 1 }),
  checkpointWhen: () => false,
})

type ThreadFields = {
  readonly projectId: string
  readonly parentId?: number
  readonly anchorTaskId?: string
  readonly title: string
  readonly role: ThreadRole
  readonly run?: number
  readonly statusLine?: string
  readonly beatAt?: number
  readonly deadlineAt?: number
  readonly result?: string
  readonly clientRequestId?: string
}

export type ThreadState =
  | (ThreadFields & { readonly status: "working" })
  | (ThreadFields & { readonly status: "waiting" })
  | (ThreadFields & { readonly status: "completed"; readonly result: string })
  | (ThreadFields & { readonly status: "failed"; readonly result: string })
  | (ThreadFields & { readonly status: "cancelled" })

function threadFields(value: ThreadDocState): ThreadFields {
  return {
    projectId: value.projectId,
    title: value.title,
    role: value.role,
    ...(value.parentId === undefined ? {} : { parentId: value.parentId }),
    ...(value.anchorTaskId === undefined ? {} : { anchorTaskId: value.anchorTaskId }),
    ...(value.run === undefined ? {} : { run: value.run }),
    ...(value.statusLine === undefined ? {} : { statusLine: value.statusLine }),
    ...(value.beatAt === undefined ? {} : { beatAt: value.beatAt }),
    ...(value.deadlineAt === undefined ? {} : { deadlineAt: value.deadlineAt }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.clientRequestId === undefined ? {} : { clientRequestId: value.clientRequestId }),
  }
}

export function threadState(value: unknown): ThreadState | undefined {
  if (!parseThread.check(value)) return undefined
  const fields = threadFields(value)
  switch (value.status) {
    case "working":
      return { ...fields, status: "working" }
    case "waiting":
      return { ...fields, status: "waiting" }
    case "cancelled":
      return { ...fields, status: "cancelled" }
    case "completed":
      return value.result === undefined ? undefined : { ...fields, status: "completed", result: value.result }
    case "failed":
      return value.result === undefined ? undefined : { ...fields, status: "failed", result: value.result }
    default: {
      const _exhaustive: never = value.status
      return _exhaustive
    }
  }
}

export type ThreadEvent = "done" | "ask_user" | "unanswered" | "abort" | "answer" | "thread_send"

export type Transition =
  | { readonly kind: "ok"; readonly status: ThreadStatus }
  | { readonly kind: "rejected"; readonly reason: string }

const TRANSITIONS: Readonly<Record<ThreadStatus, Partial<Record<ThreadEvent, ThreadStatus>>>> = {
  working: { done: "completed", ask_user: "waiting", unanswered: "failed", abort: "cancelled" },
  waiting: { answer: "working" },
  completed: { thread_send: "working" },
  failed: { thread_send: "working" },
  cancelled: { thread_send: "working" },
}

export function transition(status: ThreadStatus, event: ThreadEvent): Transition {
  const next = TRANSITIONS[status][event]
  return next === undefined
    ? { kind: "rejected", reason: `a ${status} thread does not accept ${event}` }
    : { kind: "ok", status: next }
}

export type NewThread = {
  readonly projectId: ProjectId
  readonly threadId: ThreadId
  readonly title: string
  readonly role?: ThreadRole
  readonly parentId?: ThreadId
  readonly anchorTaskId?: string
  readonly status?: ThreadStatus
  readonly run?: number
  readonly statusLine?: string
  readonly result?: string
  readonly beatAt?: number
  readonly deadlineAt?: number
  readonly clientRequestId?: string
}

export async function addThread(tx: Tx, thread: NewThread): Promise<ThreadState> {
  const workspace = await tx.doc(WorkspaceDoc)
  const project = workspace.projects[thread.projectId]
  if (project === undefined) throw new OpRejected("bad_args", `no project ${thread.projectId}`)
  const status = thread.status ?? "working"
  if ((status === "completed" || status === "failed") && thread.result === undefined)
    throw new OpRejected("bad_args", `a ${status} thread needs a result`)
  const beatAt = thread.beatAt ?? Date.now()
  const deadlineAt = thread.deadlineAt ?? beatAt + project.settings.deadlineMs
  const doc = await tx.doc(ThreadDoc, thread.threadId)
  const value: ThreadDocState = {
    projectId: thread.projectId,
    title: thread.title,
    role: thread.role ?? "thread",
    status,
    run: thread.run ?? 1,
    beatAt,
    deadlineAt,
    ...(thread.parentId === undefined ? {} : { parentId: thread.parentId }),
    ...(thread.anchorTaskId === undefined ? {} : { anchorTaskId: thread.anchorTaskId }),
    ...(thread.statusLine === undefined ? {} : { statusLine: thread.statusLine }),
    ...(thread.result === undefined ? {} : { result: thread.result }),
    ...(thread.clientRequestId === undefined ? {} : { clientRequestId: thread.clientRequestId }),
  }
  Object.assign(doc, value)
  if (!project.threadIds.includes(thread.threadId)) project.threadIds.push(thread.threadId)
  const state = threadState(value)
  if (state === undefined) throw new Error(`thread ${thread.threadId} does not satisfy xin.thread`)
  return state
}

export async function projectOf(
  harness: Harness,
  threadId: ThreadId,
  ctx: Context = BACKGROUND_CONTEXT,
): Promise<ProjectId | undefined> {
  const value = await harness.snapshot(ThreadDoc, threadId, ctx)
  return value === undefined ? undefined : (value.projectId as ProjectId)
}

export type ThreadScope = {
  readonly projectId: string
  readonly project: ProjectState
  readonly doc: ThreadDocState
}

export type CallerProject = { readonly projectId: string; readonly project: ProjectState }

export async function projectInScope(
  read: DocumentReader,
  callerId: ConversationId,
): Promise<CallerProject | undefined> {
  const workspace = await read.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return undefined
  for (const [projectId, project] of Object.entries(workspace.projects)) {
    if (project.coordinatorId === callerId) return { projectId, project }
  }
  const own = await read.snapshot(ThreadDoc, callerId, context)
  if (own === undefined) return undefined
  const project = workspace.projects[own.projectId]
  return project === undefined ? undefined : { projectId: own.projectId, project }
}

export async function threadInScope(
  read: DocumentReader,
  callerId: ConversationId,
  threadId: number,
): Promise<ThreadScope | undefined> {
  const scope = await projectInScope(read, callerId)
  if (scope === undefined) return undefined
  if (!scope.project.threadIds.includes(threadId)) return undefined
  const doc = await read.snapshot(ThreadDoc, threadId as ConversationId, context)
  return doc === undefined ? undefined : { ...scope, doc }
}
