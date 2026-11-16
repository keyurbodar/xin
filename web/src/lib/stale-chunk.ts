const FETCH_FAILED =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/
const GUARD = "stale"
const GUARD_MS = 10 * 60_000

const unsentDrafts = new Set<() => boolean>()
let reloading = false

/** Keeps a stale chunk from reloading the page while `unsent` reports a draft the reload would lose; call the result to stop. */
export function holdReloadWhile(unsent: () => boolean): () => void {
  unsentDrafts.add(unsent)
  return () => unsentDrafts.delete(unsent)
}

/**
 * After a redeploy the running bundle still names chunks the server no longer has, so retrying the import can never
 * succeed. When `error` is such a fetch failure this reloads the page once, with a fresh `?stale=` so the new
 * index.html is fetched; it declines when the last such reload was recent, while offline, or while a draft is unsent,
 * leaving the caller's in-place recovery. Returns whether the page is reloading.
 */
export function reloadForStaleChunk(error: unknown): boolean {
  if (reloading) return true
  if (!(error instanceof Error) || !FETCH_FAILED.test(error.message) || !navigator.onLine) return false
  const url = new URL(location.href)
  if (Date.now() - Number(url.searchParams.get(GUARD)) < GUARD_MS) return false
  if ([...unsentDrafts].some((unsent) => unsent())) return false
  reloading = true
  url.searchParams.set(GUARD, String(Date.now()))
  location.replace(url)
  return true
}

/** Routes vite's failed-preload event, which every built dynamic import raises, through `reloadForStaleChunk`. */
export function recoverStaleChunks(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForStaleChunk(event.payload)) event.preventDefault()
  })
}
