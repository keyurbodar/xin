import "@ui-sdk/web/dialog"
import "@ui-sdk/web/listbox"
import { Check, ChevronLeft, ChevronRight, Copy, Download, Minus, Plus, RotateCcw, X } from "lucide-solid"
import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js"
import { bytes } from "../../lib/format.ts"
import { keyStarted } from "../../lib/motion.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { DIALOG_BACKDROP, resetOnOpen } from "./dialog.tsx"

export type LightboxItem = {
  readonly src: string
  readonly name: string
  readonly size?: number | undefined
  readonly type?: string | undefined
}

type Size = { readonly width: number; readonly height: number }
type Point = { readonly x: number; readonly y: number }

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const
const EPSILON = 0.001
const COPIED_MS = 1500
const BLOCKED_MS = 4000

const ICON_BUTTON =
  "im-press im-hover grid h-[var(--h-control)] w-[var(--h-control)] shrink-0 place-items-center rounded-sm border border-line-2 bg-card text-ink-2 hover:bg-card-hover hover:text-ink disabled:opacity-40"

const ZOOM_BUTTON =
  "im-press im-hover flex h-[var(--h-control-sm)] min-w-[var(--h-control-sm)] items-center justify-center rounded-xs px-1.5 text-small text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"

async function pngBlob(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob()
  if (blob.type === "image/png") return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: "image/png" })
}

async function copyImage(src: string): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob(src) })])
    return true
  } catch {
    return navigator.clipboard.writeText(new URL(src, location.href).href).then(
      () => true,
      () => false,
    )
  }
}

const crossOrigin = (src: string): boolean => {
  const url = new URL(src, location.href)
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin
}

async function downloadRemote(item: LightboxItem): Promise<void> {
  try {
    const response = await fetch(item.src)
    if (!response.ok) throw new Error(String(response.status))
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = item.name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url))
  } catch {
    window.open(item.src, "_blank", "noopener")
  }
}

/** Full-screen viewer for a set of images on ui-sdk's Dialog: arrows and a thumbnail Listbox move between them, + − 0 zoom, a drag pans. */
export function Lightbox(props: {
  items: readonly LightboxItem[]
  index: number
  open: boolean
  onClose: () => void
  onIndexChange: (index: number) => void
}): JSX.Element {
  const { mounted, settle } = createOverlayMount(() => props.open)
  const [stage, setStage] = createSignal<Size>({ width: 0, height: 0 })
  const [natural, setNatural] = createSignal<Readonly<Record<string, Size>>>({})
  const [zoom, setZoom] = createSignal<number | null>(null)
  const [pan, setPan] = createSignal<Point>({ x: 0, y: 0 })
  const [drag, setDrag] = createSignal<{ readonly pointer: number; readonly from: Point; readonly start: Point } | null>(null)
  const [copied, setCopied] = createSignal<"copied" | "failed">()
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  let observer: ResizeObserver | undefined
  let strip: HTMLElement | undefined
  const [seen, setSeen] = createSignal<ReadonlySet<Element>>(new Set())
  const thumbs = new IntersectionObserver((entries) => {
    const shown = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target)
    if (shown.length > 0) setSeen((all) => new Set([...all, ...shown]))
  })

  const many = (): boolean => props.items.length > 1
  const current = (): LightboxItem | undefined => props.items[props.index]
  const sizeOf = (item: LightboxItem | undefined): Size | undefined => (item === undefined ? undefined : natural()[item.src])
  const fitOf = (item: LightboxItem | undefined): number => {
    const size = sizeOf(item)
    const box = stage()
    if (size === undefined || box.width === 0 || box.height === 0) return 1
    return Math.min(box.width / size.width, box.height / size.height, 1)
  }
  const scale = (): number => zoom() ?? fitOf(current())
  const limit = (at: number): Point => {
    const size = sizeOf(current())
    const box = stage()
    if (size === undefined) return { x: 0, y: 0 }
    return { x: Math.max(0, (size.width * at - box.width) / 2), y: Math.max(0, (size.height * at - box.height) / 2) }
  }
  const clampPan = (point: Point, at: number): Point => {
    const max = limit(at)
    return { x: Math.min(max.x, Math.max(-max.x, point.x)), y: Math.min(max.y, Math.max(-max.y, point.y)) }
  }
  const pannable = (): boolean => {
    const max = limit(scale())
    return max.x > 0 || max.y > 0
  }

  const zoomTo = (next: number | null): void => {
    setZoom(next)
    setPan((point) => clampPan(point, next ?? fitOf(current())))
  }
  const zoomIn = (): void => zoomTo(ZOOM_STEPS.find((step) => step > scale() + EPSILON) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!)
  const zoomOut = (): void => zoomTo(ZOOM_STEPS.findLast((step) => step < scale() - EPSILON) ?? ZOOM_STEPS[0])
  let epoch = 0
  const alive = (): (() => boolean) => {
    const started = epoch
    return () => started === epoch
  }
  const reset = (): void => {
    epoch++
    clearTimeout(copiedTimer)
    setCopied(undefined)
    setZoom(null)
    setPan({ x: 0, y: 0 })
  }

  const go = (index: number): void => {
    if (index < 0 || index >= props.items.length || index === props.index) return
    props.onIndexChange(index)
  }

  resetOnOpen(() => props.open, reset)
  createEffect(on(() => props.index, reset, { defer: true }))
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) epoch++
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    const index = props.index
    if (!props.open) return
    strip?.querySelectorAll("ui-listbox-item")[index]?.scrollIntoView({ block: "nearest", inline: "nearest" })
  })
  onCleanup(() => {
    clearTimeout(copiedTimer)
    observer?.disconnect()
    thumbs.disconnect()
  })

  const measure = (element: HTMLDivElement): void => {
    observer?.disconnect()
    observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setStage({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
  }

  const copy = async (): Promise<void> => {
    const item = current()
    if (item === undefined) return
    const live = alive()
    const outcome = (await copyImage(item.src)) ? "copied" : "failed"
    if (!live()) return
    setCopied(outcome)
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setCopied(undefined), outcome === "copied" ? COPIED_MS : BLOCKED_MS)
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target
    if (target instanceof Element && target.closest("ui-listbox") !== null) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") return
    }
    switch (event.key) {
      case "ArrowLeft":
        go(props.index - 1)
        break
      case "ArrowRight":
        go(props.index + 1)
        break
      case "+":
      case "=":
        zoomIn()
        break
      case "-":
      case "_":
        zoomOut()
        break
      case "0":
        reset()
        break
      default:
        return
    }
    event.preventDefault()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !pannable() || !(event.currentTarget instanceof HTMLElement)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ pointer: event.pointerId, from: { x: event.clientX, y: event.clientY }, start: pan() })
  }
  const onPointerMove = (event: PointerEvent): void => {
    const active = drag()
    if (active === null || active.pointer !== event.pointerId) return
    setPan(clampPan({ x: active.start.x + event.clientX - active.from.x, y: active.start.y + event.clientY - active.from.y }, scale()))
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (drag()?.pointer === event.pointerId) setDrag(null)
  }

  return (
    <Show when={mounted()}>
      <ui-dialog
        prop:open={props.open}
        on:openchange={(event) => {
          if (event.detail.value) return
          event.preventDefault()
          queueMicrotask(props.onClose)
        }}
        on:openchangecomplete={settle}
      >
        <ui-dialog-backdrop class={DIALOG_BACKDROP} />
        <ui-dialog-content
          initial-focus={many() ? "ui-listbox-item[data-selected]" : "content"}
          class="im-dialog fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-bg/70 p-0 text-ink outline-none"
          on:keydown={onKey}
        >
          <div class="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[var(--h-header)_minmax(0,1fr)_auto]">
            <header class="relative flex items-center gap-2 px-3 sm:px-4">
              <ui-dialog-title class="flex min-w-0 max-w-[calc(50%-2.5rem)] items-baseline gap-2 text-small">
                <span class="truncate text-ink">{current()?.name}</span>
                <Show when={current()?.size}>{(size) => <span class="shrink-0 text-micro text-ink-3">{bytes(size())}</span>}</Show>
              </ui-dialog-title>
              <Show when={many()}>
                <span
                  data-testid="lightbox-counter"
                  aria-live="polite"
                  aria-atomic="true"
                  class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-small font-title tabular-nums text-ink"
                >
                  {props.index + 1} / {props.items.length}
                </span>
              </Show>
              <div class="ml-auto flex items-center gap-2">
                <Show when={copied() === "failed"}>
                  <p
                    role="status"
                    class="absolute right-3 top-full z-10 rounded-sm border border-line-2 bg-card px-2 py-1 text-micro text-failed sm:right-4"
                  >
                    The browser blocked the clipboard.
                  </p>
                </Show>
                <button
                  type="button"
                  aria-label={copied() === "copied" ? "Copied" : "Copy image"}
                  class={ICON_BUTTON}
                  onClick={() => void copy()}
                >
                  <Show when={copied() === "copied"} fallback={<Copy size={15} />}>
                    <Check size={15} />
                  </Show>
                </button>
                <a
                  href={current()?.src}
                  download={current()?.name}
                  aria-label="Download"
                  class={ICON_BUTTON}
                  onClick={(event) => {
                    const item = current()
                    if (item === undefined || !crossOrigin(item.src)) return
                    event.preventDefault()
                    void downloadRemote(item)
                  }}
                >
                  <Download size={15} />
                </a>
                <button type="button" aria-label="Close" class={ICON_BUTTON} onClick={() => props.onClose()}>
                  <X size={15} />
                </button>
              </div>
            </header>

            <div class="grid min-h-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 sm:gap-4 sm:px-4">
              <Show when={many()} fallback={<span />}>
                <button
                  type="button"
                  aria-label="Previous image"
                  disabled={props.index === 0}
                  class={ICON_BUTTON}
                  onClick={() => go(props.index - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
              </Show>
              <div
                ref={measure}
                data-testid="lightbox-stage"
                data-instant={keyStarted() ? "" : undefined}
                class="im-crossfade relative h-full touch-none overflow-hidden"
                classList={{ "cursor-grab": pannable() && drag() === null, "cursor-grabbing": drag() !== null }}
                on:pointerdown={onPointerDown}
                on:pointermove={onPointerMove}
                on:pointerup={onPointerUp}
                on:pointercancel={onPointerUp}
              >
                <For each={props.items}>
                  {(item, index) => {
                    const active = (): boolean => index() === props.index
                    const size = (): Size | undefined => sizeOf(item)
                    const at = (): number => (active() ? scale() : fitOf(item))
                    const offset = (): Point => (active() ? pan() : { x: 0, y: 0 })
                    return (
                      <Show when={Math.abs(index() - props.index) <= 1}>
                      <img
                        src={item.src}
                        alt={active() ? item.name : ""}
                        aria-hidden={active() ? undefined : "true"}
                        draggable={false}
                        data-active={active() && size() !== undefined ? "" : undefined}
                        class="absolute left-1/2 top-1/2 max-w-none select-none"
                        style={{
                          width: size() === undefined ? undefined : `${size()!.width}px`,
                          height: size() === undefined ? undefined : `${size()!.height}px`,
                          transform: `translate(-50%, -50%) translate(${offset().x}px, ${offset().y}px) scale(${at()})`,
                        }}
                        onLoad={(event) => {
                          const image = event.currentTarget
                          setNatural((all) => ({ ...all, [item.src]: { width: image.naturalWidth, height: image.naturalHeight } }))
                        }}
                      />
                      </Show>
                    )
                  }}
                </For>
              </div>
              <Show when={many()} fallback={<span />}>
                <button
                  type="button"
                  aria-label="Next image"
                  disabled={props.index === props.items.length - 1}
                  class={ICON_BUTTON}
                  onClick={() => go(props.index + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </Show>
            </div>

            <footer class="flex flex-col-reverse items-center gap-2 px-3 pb-3 pt-2 md:relative md:block md:px-4 md:pb-4">
              <div
                role="group"
                aria-label="Zoom"
                class="flex items-center gap-0.5 rounded-md border border-line-2 bg-card p-0.5 md:absolute md:bottom-4 md:left-4"
              >
                <button type="button" aria-label="Zoom out" class={ZOOM_BUTTON} onClick={zoomOut} disabled={scale() <= ZOOM_STEPS[0] + EPSILON}>
                  <Minus size={14} />
                </button>
                <output data-testid="lightbox-zoom" aria-live="polite" class="w-12 text-center text-small tabular-nums text-ink">
                  {Math.round(scale() * 100)}%
                </output>
                <button
                  type="button"
                  aria-label="Zoom in"
                  class={ZOOM_BUTTON}
                  onClick={zoomIn}
                  disabled={scale() >= ZOOM_STEPS[ZOOM_STEPS.length - 1]! - EPSILON}
                >
                  <Plus size={14} />
                </button>
                <button type="button" class={ZOOM_BUTTON} aria-pressed={zoom() === 1} onClick={() => zoomTo(1)}>
                  100%
                </button>
                <button type="button" class={ZOOM_BUTTON} aria-pressed={zoom() === 2} onClick={() => zoomTo(2)}>
                  200%
                </button>
                <button type="button" aria-label="Fit to screen" class={ZOOM_BUTTON} onClick={reset}>
                  <RotateCcw size={14} />
                </button>
              </div>
              <Show when={many()}>
                <ui-listbox
                  ref={strip}
                  aria-label="Images"
                  orientation="horizontal"
                  loop="false"
                  prop:value={String(props.index)}
                  class="mx-auto flex w-fit max-w-full gap-2 overflow-x-auto p-1 outline-none md:max-w-[calc(100%-34rem)]"
                  on:valuechange={(event) => {
                    event.preventDefault()
                    const value = event.detail.value
                    if (typeof value === "string") queueMicrotask(() => go(Number(value)))
                  }}
                >
                  <For each={props.items}>
                    {(item, index) => {
                      let thumb: HTMLElement | undefined
                      onCleanup(() => {
                        if (thumb !== undefined) thumbs.unobserve(thumb)
                      })
                      return (
                      <ui-listbox-item
                        ref={(element: HTMLElement) => {
                          thumb = element
                          thumbs.observe(element)
                        }}
                        value={String(index())}
                        aria-label={item.name}
                        class="block h-12 w-16 shrink-0 cursor-default overflow-hidden rounded-sm border border-line-2 opacity-60 outline-none hover:opacity-90 data-[selected]:border-ink data-[selected]:opacity-100"
                      >
                        <img
                          src={thumb !== undefined && seen().has(thumb) ? item.src : undefined}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          width="64"
                          height="48"
                          draggable={false}
                          class="h-full w-full object-cover"
                        />
                      </ui-listbox-item>
                      )
                    }}
                  </For>
                </ui-listbox>
              </Show>
            </footer>
          </div>
        </ui-dialog-content>
      </ui-dialog>
    </Show>
  )
}
