const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Where Tab goes inside a trap of `count` stops; -1 means focus is outside it, so it enters at the near end. */
export function nextFocus(count: number, current: number, backwards: boolean): number | undefined {
  if (count === 0) return undefined
  if (current < 0) return backwards ? count - 1 : 0
  return (current + (backwards ? count - 1 : 1)) % count
}

/** Keeps Tab inside `container`; the caller wires it to keydown and owns focus restore. */
export function trapTab(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return
  const stops = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const active = document.activeElement
  const next = nextFocus(stops.length, stops.findIndex((stop) => stop === active), event.shiftKey)
  event.preventDefault()
  if (next !== undefined) stops[next]?.focus()
}
