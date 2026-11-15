import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const ARRIVAL_MS = 200 + 5 * 40

const MOVING = ".im-pop, .im-tip, .im-dialog, .im-sheet, .im-drawer, .im-scrim, .im-pane, .im-tab, .im-grow, .im-switch, .im-chevron, .im-pill"

const root = document.documentElement
const [keyboard, setKeyboard] = createSignal(false)

export const keyStarted = keyboard


/**
 * Marks the root for the motion file: `data-visibility` pauses loops while the tab is hidden, and every moving
 * primitive gets `data-instant` when it mounts or changes state after a keypress, so keyboard-started actions do not animate.
 */
export function trackMotion(): void {
  window.addEventListener("keydown", () => setKeyboard(true), true)
  window.addEventListener("pointerdown", () => setKeyboard(false), true)
  window.addEventListener("pointermove", () => setKeyboard(false), { capture: true, passive: true })
  const visibility = (): void => root.setAttribute("data-visibility", document.hidden ? "hidden" : "visible")
  visibility()
  document.addEventListener("visibilitychange", visibility)
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof Element && record.target.matches(MOVING)) record.target.toggleAttribute("data-instant", keyboard())
        continue
      }
      if (!keyboard()) continue
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(MOVING)) node.setAttribute("data-instant", "")
        for (const inner of node.querySelectorAll(MOVING)) inner.setAttribute("data-instant", "")
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-state", "data-open", "data-closing", "aria-checked", "style"],
  })
}

/** Staggers a list's rows in on its first load only, through `.im-stagger` and each row's `--i`. */
export function stagger(list: () => HTMLElement | undefined, ready: Accessor<boolean>): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const element = list()
    if (timer !== undefined || element === undefined || !ready()) return
    for (const [index, child] of [...element.children].entries()) {
      if (child instanceof HTMLElement) child.style.setProperty("--i", String(index))
    }
    element.classList.add("im-stagger")
    timer = setTimeout(() => element.classList.remove("im-stagger"), ARRIVAL_MS)
  })
  onCleanup(() => clearTimeout(timer))
}
