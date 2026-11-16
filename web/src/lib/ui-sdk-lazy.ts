const LOADERS = {
  menu: () => import("@ui-sdk/web/menu"),
  "segmented-control": () => import("@ui-sdk/web/segmented-control"),
} as const

export type LazyElements = keyof typeof LOADERS

const ready = new Set<LazyElements>()
const pending = new Map<LazyElements, Promise<void>>()

/** Whether a UI SDK element family has registered, so a trigger can let the element take its own events. */
export const uiSdkReady = (name: LazyElements): boolean => ready.has(name)

/**
 * Registers a UI SDK element family off the startup path, once: concurrent callers share one import and a failed
 * import is retried by the next caller. Elements already in the page upgrade in place when it lands.
 */
export function loadUiSdk(name: LazyElements): Promise<void> {
  if (ready.has(name)) return Promise.resolve()
  const running =
    pending.get(name) ??
    LOADERS[name]().then(
      () => {
        ready.add(name)
        pending.delete(name)
      },
      (error: unknown) => {
        pending.delete(name)
        throw error
      },
    )
  pending.set(name, running)
  return running
}

/** Starts loading an element family ahead of use; a failed load is left for the next press to retry. */
export function warmUiSdk(name: LazyElements): void {
  loadUiSdk(name).catch(() => undefined)
}

const holding = new Set<LazyElements>()

/**
 * Lets a press that lands before an element family has registered count once: it is held, and `again` is sent to
 * the same target on the frame after the load. Presses while one is held are dropped, so a double press opens a
 * menu once instead of opening and closing it, and a failed load drops the held press so the next one retries.
 */
export function replayWhenReady(name: LazyElements, event: Event, again: () => Event): void {
  if (ready.has(name)) return
  event.preventDefault()
  const target = event.target
  if (holding.has(name) || target === null) return
  holding.add(name)
  loadUiSdk(name).then(
    () =>
      requestAnimationFrame(() => {
        holding.delete(name)
        target.dispatchEvent(again())
      }),
    () => holding.delete(name),
  )
}
