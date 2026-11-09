import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, Harness } from "@earendil-works/pi-durable"
import { defaultSpaceOf, ThreadDoc } from "./threaddoc.ts"
import { PuckDoc } from "./puck.ts"
import { WorkspaceDoc, type ProjectState, type SpaceState } from "./workspace.ts"

const context = BACKGROUND_CONTEXT

/**
 * Who is asking. The session root is Puck, a space coordinator is a Space, and a conversation
 * with a thread document is a thread. Project and Space are separate records; a Space names
 * the project it runs in, and a thread keeps the project it was started with even if its Space
 * moves.
 */
export type Scope =
  | { readonly kind: "puck" }
  | {
      readonly kind: "space"
      readonly spaceId: string
      readonly space: SpaceState
      readonly projectId: string
      readonly project?: ProjectState
    }
  | {
      readonly kind: "thread"
      readonly spaceId: string
      readonly space: SpaceState
      readonly projectId: string
      readonly project?: ProjectState
      readonly threadId: ConversationId
    }

export type ResolvedProject = { readonly projectId: string; readonly project: ProjectState }

export async function scopeOf(harness: Harness, callerId: ConversationId): Promise<Scope | undefined> {
  const root = await harness.root(context)
  if (root.id === callerId) return { kind: "puck" }
  const puck = await harness.snapshot(PuckDoc, context)
  if (puck?.conversations[String(callerId)] !== undefined) return { kind: "puck" }
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return undefined
  const own = await harness.snapshot(ThreadDoc, callerId, context)
  if (own !== undefined) {
    const spaceId = own.spaceId ?? defaultSpaceOf(workspace, own.projectId)
    if (spaceId === undefined) return undefined
    const space = workspace.spaces[spaceId]
    if (space === undefined) return undefined
    const project = workspace.projects[own.projectId]
    return {
      kind: "thread",
      threadId: callerId,
      spaceId,
      space,
      projectId: own.projectId,
      ...(project === undefined ? {} : { project }),
    }
  }
  for (const [spaceId, space] of Object.entries(workspace.spaces)) {
    if (space.coordinatorId !== callerId) continue
    const project = workspace.projects[space.projectId]
    return {
      kind: "space",
      spaceId,
      space,
      projectId: space.projectId,
      ...(project === undefined ? {} : { project }),
    }
  }
  return undefined
}

export async function projectByRef(harness: Harness, ref: string): Promise<ResolvedProject | undefined> {
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return undefined
  for (const [projectId, project] of Object.entries(workspace.projects)) {
    if (project.archived) continue
    if (projectId === ref || project.slug === ref) return { projectId, project }
  }
  return undefined
}

export async function canUseThread(harness: Harness, callerId: ConversationId, threadId: number): Promise<boolean> {
  const scope = await scopeOf(harness, callerId)
  if (scope === undefined) return false
  if (scope.kind === "puck") {
    const workspace = await harness.snapshot(WorkspaceDoc, context)
    return (
      workspace !== undefined && Object.values(workspace.spaces).some((space) => space.threadIds.includes(threadId))
    )
  }
  return scope.space.threadIds.includes(threadId)
}
