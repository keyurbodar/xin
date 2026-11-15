import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const ARRIVAL_MS = 200 + 5 * 40

const root = document.documentElement

export function trackMotion(): void {
  const mark = (input: "key" | "pointer"): void => {
    if (root.dataset["input"] !== input) root.dataset["input"] = input
  }
  window.addEventListener("keydown", () => mark("key"), true)
  window.addEventListener("pointerdown", () => mark("pointer"), true)
  window.addEventListener("pointermove", () => mark("pointer"), { capture: true, passive: true })
  document.addEventListener("visibilitychange", () => {
    root.toggleAttribute("data-hidden", document.hidden)
    root.dataset["visibility"] = document.hidden ? "hidden" : "visible"
  })
}

export function keyStarted(): boolean {
  return root.dataset["input"] === "key"
}

/** True from the moment a list first has rows until its staggered arrival has played. */
export function arrival(ready: Accessor<boolean>): Accessor<boolean> {
  const [arriving, setArriving] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (timer !== undefined || !ready()) return
    setArriving(true)
    timer = setTimeout(() => setArriving(false), ARRIVAL_MS)
  })
  onCleanup(() => clearTimeout(timer))
  return arriving
}

/** Slides an element from where another element was, on transform alone. */
export function glide(from: DOMRect, element: HTMLElement): void {
  if (keyStarted() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const to = element.getBoundingClientRect()
  if (to.width === 0) return
  const style = getComputedStyle(element)
  element.animate(
    [
      { transformOrigin: "left center", transform: `translateX(${from.left - to.left}px) scaleX(${from.width / to.width})` },
      { transformOrigin: "left center", transform: "none" },
    ],
    { duration: Number.parseFloat(style.getPropertyValue("--dur-base")), easing: style.getPropertyValue("--ease-in-out") },
  )
}
