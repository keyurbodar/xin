import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { Background } from "./model.ts"
import { loadImage, paintFromRoot, renderBackground } from "./render.ts"
import { appearance, variant } from "./store.ts"

/** The wallpaper layer: fills its positioned parent, fades into the page colour at the bottom, and never takes pointer events. */
export function Backdrop(props: { readonly background?: Background; readonly class?: string; readonly ground?: "bg" | "panel" }): JSX.Element {
  const ground = (): string => `var(--color-${props.ground ?? "bg"})`
  const background = (): Background => props.background ?? appearance().background
  const [ready, setReady] = createSignal(false)
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined

  onMount(() => {
    if (host === undefined) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return
      const width = Math.round(entry.contentRect.width / 32) * 32
      const height = Math.round(entry.contentRect.height / 32) * 32
      const last = size()
      if (last.width !== width || last.height !== height) setSize({ width, height })
    })
    observer.observe(host)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const current = background()
    const { width, height } = size()
    variant()
    appearance().theme
    const url = current.image?.url
    if (url === undefined || canvas === undefined || width === 0 || height === 0) return
    let live = true
    onCleanup(() => {
      live = false
    })
    void loadImage(url).then(
      (image) => {
        if (!live || canvas === undefined) return
        renderBackground(canvas, image, current, paintFromRoot(), width, height)
        setReady(true)
      },
      () => setReady(false),
    )
  })

  return (
    <div
      ref={host}
      aria-hidden="true"
      class={`pointer-events-none absolute inset-0 overflow-hidden ${props.class ?? ""}`}
      classList={{ hidden: background().image === undefined }}
    >
      <canvas
        ref={canvas}
        class="appearance-fade absolute inset-0 h-full w-full"
        style={{ opacity: ready() && background().image !== undefined ? background().opacity / 100 : 0 }}
      />
      <Show when={background().image !== undefined}>
        <div class="absolute inset-0" style={{ background: ground(), opacity: background().overlay / 100 }} />
        <div
          class="absolute inset-x-0 bottom-0 h-3/5"
          style={{
            background: `linear-gradient(to bottom, transparent, ${ground()})`,
            opacity: background().fade / 100,
          }}
        />
      </Show>
    </div>
  )
}
