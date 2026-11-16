import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Dialog } from "../ui/dialog.tsx"
import { Icon } from "../ui/icon.tsx"
import { MorphIcon } from "../ui/morph-icon.tsx"
import { createPresence } from "../shell/presence.ts"

export const CODE_LIMIT = 420
export const BLOCK_LIMIT = 480
const SLACK = 72
const GROW_MS = 240

let ids = 0

export function Expandable(props: { limit: number; streaming: boolean; summary?: string; children: JSX.Element }): JSX.Element {
  const id = `expandable-${(ids += 1)}`
  const [height, setHeight] = createSignal(0)
  const [open, setOpen] = createSignal(false)
  const [animating, setAnimating] = createSignal(false)
  let wrapper!: HTMLDivElement
  let content!: HTMLDivElement
  let timer: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    const observer = new ResizeObserver(() => setHeight(content.scrollHeight))
    observer.observe(content)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => clearTimeout(timer))

  const collapsible = (): boolean => !props.streaming && height() > props.limit + SLACK
  const collapsed = (): boolean => collapsible() && !open()
  const maxHeight = (): string | undefined => {
    if (!collapsible()) return undefined
    return `${open() ? height() : props.limit}px`
  }

  const toggle = (): void => {
    clearTimeout(timer)
    setAnimating(true)
    timer = setTimeout(() => setAnimating(false), GROW_MS)
    const closing = open()
    setOpen(!closing)
    if (closing && wrapper.getBoundingClientRect().top < 0) wrapper.scrollIntoView({ block: "start" })
  }

  return (
    <div ref={wrapper} class="relative">
      <div
        id={id}
        class="block-expand relative overflow-hidden"
        data-animate={animating() ? "" : undefined}
        data-collapsed={collapsed() ? "" : undefined}
        style={{ "max-height": maxHeight() }}
      >
        <div ref={content}>{props.children}</div>
        <Show when={collapsed()}>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-linear-to-t from-panel to-transparent" />
        </Show>
      </div>
      <Show when={collapsible()}>
        <button
          type="button"
          aria-expanded={open()}
          aria-controls={id}
          onClick={toggle}
          class="im-press flex h-8 w-full items-center justify-center gap-1.5 border-t border-line-1 font-mono text-2xs text-ink-3 hover:text-ink"
        >
          <MorphIcon kind="chevron" on={open()} size={13} />
          <span>{open() ? "Collapse" : "Expand"}</span>
          <Show when={props.summary !== undefined && !open()}>
            <span class="text-ink-3">· {props.summary}</span>
          </Show>
        </button>
      </Show>
    </div>
  )
}

export function FullscreenButton(props: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onClick()}
      class="im-press grid h-6 w-6 place-items-center rounded-sm hover:text-ink"
    >
      <Icon name="maximize" size={13} />
    </button>
  )
}

export function Fullscreen(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element }): JSX.Element {
  const { mounted } = createPresence(() => props.open, 180)
  return (
    <Show when={mounted()}>
      <Portal>
        <Dialog open={props.open} onClose={props.onClose} title={props.title} width="w-[calc(100vw-32px)]">
          <div autofocus tabindex="0" class="block-fullscreen max-h-[calc(100vh-120px)] overflow-auto outline-none">
            {props.children}
          </div>
        </Dialog>
      </Portal>
    </Show>
  )
}
