import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineDoc, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable"
import { bool, compile, int, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema"
import type { ProjectId, ThreadId } from "../ids.ts"
import { WorkspaceDoc, type ProjectState, type SpaceState, type WorkspaceState } from "./workspace.ts"

const context = BACKGROUND_CONTEXT

const ROLES = ["chat", "thread", "utility"] as const
const STATUSES = ["working", "waiting", "completed", "failed", "cancelled"] as const

export const RoleSchema = oneOf(ROLES)
export const StatusSchema = oneOf(STATUSES)

export type ThreadRole = (typeof ROLES)[number]
export type ThreadStatus = (typeof STATUSES)[number]

const ThreadSchema = obj({
  projectId: str(),
  spaceId: opt(str()),
  archived: opt(bool()),
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
  readonly spaceId?: string
  readonly archived?: boolean
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
    ...(value.spaceId === undefined ? {} : { spaceId: value.spaceId }),
    ...(value.archived === undefined ? {} : { archived: value.archived }),
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
  readonly spaceId?: string
  readonly archived?: boolean
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

export type SpaceScope = {
  readonly spaceId: string
  readonly space: SpaceState
  readonly projectId: string
  readonly project?: ProjectState
}

export type ThreadScope = SpaceScope & { readonly doc: ThreadDocState }

export type ProjectScope = { readonly projectId: string; readonly project: ProjectState }

export function defaultSpaceOf(workspace: WorkspaceState, projectId: string): string | undefined {
  for (const [spaceId, space] of Object.entries(workspace.spaces)) {
    if (space.projectId === projectId && !space.archived) return spaceId
  }
  for (const [spaceId, space] of Object.entries(workspace.spaces)) {
    if (space.projectId === projectId) return spaceId
  }
  return undefined
}

function scopeOfSpace(workspace: WorkspaceState, spaceId: string, space: SpaceState): SpaceScope {
  const project = workspace.projects[space.projectId]
  return project === undefined
    ? { spaceId, space, projectId: space.projectId }
    : { spaceId, space, projectId: space.projectId, project }
}

export async function spaceInScope(read: DocumentReader, callerId: ConversationId): Promise<SpaceScope | undefined> {
  const workspace = await read.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return undefined
  for (const [spaceId, space] of Object.entries(workspace.spaces)) {
    if (space.coordinatorId === callerId) return scopeOfSpace(workspace, spaceId, space)
  }
  const own = await read.snapshot(ThreadDoc, callerId, context)
  if (own === undefined) return undefined
  const spaceId = own.spaceId ?? defaultSpaceOf(workspace, own.projectId)
  if (spaceId === undefined) return undefined
  const space = workspace.spaces[spaceId]
  return space === undefined ? undefined : scopeOfSpace(workspace, spaceId, space)
}

export async function projectInScope(
  read: DocumentReader,
  callerId: ConversationId,
): Promise<ProjectScope | undefined> {
  const scope = await spaceInScope(read, callerId)
  if (scope === undefined || scope.projectId === undefined || scope.project === undefined) return undefined
  return { projectId: scope.projectId, project: scope.project }
}

export async function threadInScope(
  read: DocumentReader,
  callerId: ConversationId,
  threadId: number,
): Promise<ThreadScope | undefined> {
  const scope = await spaceInScope(read, callerId)
  if (scope === undefined) return undefined
  if (!scope.space.threadIds.includes(threadId)) return undefined
  const doc = await read.snapshot(ThreadDoc, threadId as ConversationId, context)
  if (doc === undefined) return undefined
  if (doc.projectId === scope.projectId) return { ...scope, doc }
  const workspace = await read.snapshot(WorkspaceDoc, context)
  const project = workspace?.projects[doc.projectId]
  return {
    spaceId: scope.spaceId,
    space: scope.space,
    projectId: doc.projectId,
    ...(project === undefined ? {} : { project }),
    doc,
  }
}
