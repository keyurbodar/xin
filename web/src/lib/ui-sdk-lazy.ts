const LOADERS = {
  menu: () => import("@ui-sdk/web/menu"),
  "segmented-control": () => import("@ui-sdk/web/segmented-control"),
  combobox: () => import("@ui-sdk/web/combobox"),
  tooltip: () => import("@ui-sdk/web/tooltip"),
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

const loadAll = (names: readonly LazyElements[]): Promise<unknown> => Promise.all(names.map(loadUiSdk))

/** Starts loading element families ahead of use; a failed load is left for the next press to retry. */
export function warmUiSdk(...names: readonly LazyElements[]): void {
  loadAll(names).catch(() => undefined)
}

const held = new WeakMap<EventTarget, MouseEvent>()

/**
 * Lets presses that land before their element families have registered count once: the latest press on each control
 * is held, and on the frame after the load the element it hit takes focus and a copy of it (a click or a context menu,
 * with its position) is sent to that element. A double press opens a menu once instead of opening and closing it, a
 * second pick on a toggle wins over the first, and a failed load drops the held press so the next one retries.
 */
export function replayWhenReady(names: readonly LazyElements[], event: MouseEvent): void {
  if (names.every(uiSdkReady)) return
  event.preventDefault()
  const { currentTarget } = event
  if (currentTarget === null || event.target === null) return
  const loading = held.has(currentTarget)
  held.set(currentTarget, event)
  if (loading) return
  loadAll(names).then(
    () =>
      requestAnimationFrame(() => {
        const latest = held.get(currentTarget)
        held.delete(currentTarget)
        const target = latest?.target
        if (latest === undefined || !(target instanceof Element)) return
        target.closest<HTMLElement>("[tabindex], button, a[href]")?.focus({ preventScroll: true })
        target.dispatchEvent(new MouseEvent(latest.type, latest))
      }),
    () => held.delete(currentTarget),
  )
}

/** Trigger handlers that load element families on first hover, focus or press, and replay a press that came before them. */
export function loadOnIntent(...names: readonly LazyElements[]) {
  const warm = (): void => warmUiSdk(...names)
  return {
    onPointerEnter: warm,
    onPointerDown: warm,
    onFocus: warm,
    onClick: (event: MouseEvent): void => replayWhenReady(names, event),
  }
}
