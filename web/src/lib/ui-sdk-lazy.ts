const LOADERS = {
  menu: () => import("@ui-sdk/web/menu"),
  toggle: () => import("@ui-sdk/web/toggle"),
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

/** Trigger handlers that register an element family on first hover, focus or press, and replay a click that came before it. */
export function loadOnIntent(name: LazyElements) {
  const warm = (): void => void loadUiSdk(name)
  return {
    onPointerEnter: warm,
    onPointerDown: warm,
    onFocus: warm,
    onClick: (event: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
      if (uiSdkReady(name)) return
      const button = event.currentTarget
      void loadUiSdk(name).then(() => requestAnimationFrame(() => button.click()))
    },
  }
}
