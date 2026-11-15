import type { RequestRow } from "../state/conversation.ts"
import type { ThreadGroups } from "../state/home.ts"
import { spaceRequests } from "./spaces.ts"

type RequestSpace = { readonly coordinatorId: number; readonly threads: ThreadGroups; readonly openRequests: number }

/**
 * What a space's open questions depend on in a home frame: the stored count, which threads are waiting (only a
 * waiting thread's questions are listed), and the newest pending ids the frame carries. A frame that changes none
 * of these needs no `request.list`; a swap, a stop or a reconnect that changes any of them does.
 */
export function requestsKey(space: RequestSpace, homeRows: readonly RequestRow[]): string {
  const waiting = space.threads.waiting.map((thread) => thread.id).toSorted((left, right) => left - right)
  const ids = spaceRequests(space, homeRows)
    .map((request) => `${request.conversationId}:${request.id}`)
    .toSorted()
  return `${space.openRequests}|${waiting.join(",")}|${ids.join(",")}`
}

/** Runs `run` once at a time; a call that lands while one is in flight runs it once more after it settles. */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  let again = false
  const start = (): Promise<void> => {
    if (pending !== undefined) {
      again = true
      return pending
    }
    pending = run().finally(() => {
      pending = undefined
      if (!again) return
      again = false
      void start()
    })
    return pending
  }
  return start
}
