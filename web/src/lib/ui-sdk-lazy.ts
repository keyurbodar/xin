const LOADERS = {
  menu: () => import("@ui-sdk/web/menu"),
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
