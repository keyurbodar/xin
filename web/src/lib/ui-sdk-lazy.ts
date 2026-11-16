const LOADERS = {
  menu: () => import("@ui-sdk/web/menu"),
  combobox: () => import("@ui-sdk/web/combobox"),
  editor: () => Promise.all([import("@ui-sdk/web/token-input"), import("@ui-sdk/web/trigger-menu")]),
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

/**
 * Trigger handlers that load element families on first hover, focus or press, and replay a click that came before them.
 * A failed load is swallowed here; loadUiSdk forgets it, so the next intent retries.
 */
export function loadOnIntent(...names: readonly LazyElements[]) {
  const load = (): Promise<unknown> => Promise.all(names.map(loadUiSdk))
  const warm = (): void => void load().catch(() => undefined)
  return {
    onPointerEnter: warm,
    onPointerDown: warm,
    onFocus: warm,
    onClick: (event: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
      if (names.every(uiSdkReady)) return
      const button = event.currentTarget
      void load().then(
        () => requestAnimationFrame(() => button.click()),
        () => undefined,
      )
    },
  }
}
