const LOADERS = {
  menu: () => import("@ui-sdk/web/menu"),
  "segmented-control": () => import("@ui-sdk/web/segmented-control"),
  command: () => import("@ui-sdk/web/command"),
  combobox: () => import("@ui-sdk/web/combobox"),
  editor: () => Promise.all([import("@ui-sdk/web/token-input"), import("@ui-sdk/web/trigger-menu")]),
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

const loadAll = (names: readonly LazyElements[]): Promise<unknown> => Promise.all(names.map(loadUiSdk))

/** Starts loading element families ahead of use; a failed load is left for the next press to retry. */
export function warmUiSdk(...names: readonly LazyElements[]): void {
  loadAll(names).catch(() => undefined)
}

const holding = new WeakSet<EventTarget>()

/**
 * Lets a press that lands before its element families have registered count once: it is held, and the same click is
 * sent again to its target on the frame after the load. Further presses on the same control while one is held are
 * dropped, so a double press opens a menu once instead of opening and closing it, and a failed load drops the held
 * press so the next one retries the load.
 */
export function replayWhenReady(names: readonly LazyElements[], event: MouseEvent): void {
  if (names.every(uiSdkReady)) return
  event.preventDefault()
  const { target, currentTarget } = event
  if (target === null || currentTarget === null || holding.has(currentTarget)) return
  holding.add(currentTarget)
  loadAll(names).then(
    () =>
      requestAnimationFrame(() => {
        holding.delete(currentTarget)
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: event.detail }))
      }),
    () => holding.delete(currentTarget),
  )
}

/** Trigger handlers that load element families on first hover or focus, and replay a press that came before them. */
export function loadOnIntent(...names: readonly LazyElements[]) {
  const warm = (): void => warmUiSdk(...names)
  return {
    onPointerEnter: warm,
    onFocus: warm,
    onClick: (event: MouseEvent): void => replayWhenReady(names, event),
  }
}
