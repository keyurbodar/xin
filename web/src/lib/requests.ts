/**
 * Calls `refresh` for the first `requestsRev` a space shows and again only when it moves. The home bumps a space's
 * rev on every request open or resolve, so a frame or a reconnect snapshot that leaves it alone costs no `request.list`.
 */
export function onRequestsRev(refresh: () => void): (space: { readonly requestsRev: number }) => void {
  let seen: number | undefined
  return (space) => {
    if (space.requestsRev === seen) return
    seen = space.requestsRev
    refresh()
  }
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
