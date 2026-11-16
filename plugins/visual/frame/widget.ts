import type { HandlerArg, Visual } from "../runtime/lua.ts"
import type { HandlerId } from "../runtime/node.ts"
import type { FrameTheme } from "./protocol.ts"

export type WidgetHost = {
  readonly visual: Visual
  readonly theme: () => FrameTheme
  /** Run a handler, then render the view again. */
  readonly call: (id: HandlerId, arg: HandlerArg) => void
  readonly fail: (error: unknown) => void
}

export type Widget<N> = {
  readonly element: HTMLElement
  update(node: N): unknown
  /** Theme or font changed: repaint without new data. */
  repaint(): void
  destroy(): void
}

/** Calls `paint` once per animation frame while the element is on screen; `paint` returns whether to keep going. */
export function frameLoop(element: Element, paint: (time: number) => boolean): { kick(): void; stop(): void } {
  let visible = true
  let frame = 0
  let running = false
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting)
    if (visible) kick()
  })
  observer.observe(element)
  const tick = (time: number): void => {
    frame = 0
    if (!visible) {
      running = false
      return
    }
    running = paint(time / 1000)
    if (running) frame = requestAnimationFrame(tick)
  }
  const kick = (): void => {
    if (frame === 0) frame = requestAnimationFrame(tick)
  }
  return {
    kick,
    stop: () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      running = false
    },
  }
}

export function widthOf(element: HTMLElement, onResize: (width: number) => void): () => void {
  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? element.clientWidth
    onResize(Math.max(1, Math.round(width)))
  })
  observer.observe(element)
  return () => observer.disconnect()
}
