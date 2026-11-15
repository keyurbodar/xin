import type { RequestRow } from "../state/conversation.ts"
import type { ThreadGroups } from "../state/home.ts"

/** The open questions asked in this space: its coordinator's and its threads', never a sibling space's. */
export function spaceRequests(space: { readonly coordinatorId: number; readonly threads: ThreadGroups }, rows: readonly RequestRow[]): readonly RequestRow[] {
  const members = new Set([space.coordinatorId, ...Object.values(space.threads).flatMap((group) => group.map((thread) => thread.id))])
  return rows.filter((request) => members.has(request.conversationId))
}
