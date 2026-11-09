import { Show, createSignal, type JSX } from "solid-js"
import { createPresence, escapeCloses } from "./presence.ts"

export function BottomSheet(props: {
  open: boolean
  onClose: () => void
  label: string
  children: JSX.Element
}): JSX.Element {
  const [offset, setOffset] = createSignal(0)
  const [full, setFull] = createSignal(false)
  const { mounted, leaving } = createPresence(() => props.open, 200)
  let start: number | undefined

  escapeCloses(() => props.open, props.onClose)

  const down = (event: PointerEvent): void => {
    start = event.clientY
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const move = (event: PointerEvent): void => {
    if (start === undefined) return
    setOffset(Math.max(0, event.clientY - start))
  }

  const up = (): void => {
    if (start === undefined) return
    const travelled = offset()
    start = undefined
    setOffset(0)
    if (travelled > 96) {
      props.onClose()
      return
    }
    if (travelled < -64) setFull(true)
    else if (travelled > 40) setFull(false)
  }

  return (
    <Show when={mounted()}>
      <div
        class="fixed inset-0 z-40 bg-black/64 transition-opacity duration-200"
        classList={{ "fade-in opacity-100": !leaving(), "opacity-0": leaving() }}
        onMouseDown={props.onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        data-no-press
        class="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[8px] border-t border-line-strong bg-raised"
        classList={{ "sheet-in": !leaving(), "sheet-out": leaving() }}
        style={{
          height: full() ? "calc(100% - 24px)" : "76%",
          transform: offset() > 0 ? `translateY(${offset()}px)` : undefined,
          transition: start === undefined ? "transform 200ms var(--ease-standard), height 200ms var(--ease-standard)" : "none",
        }}
      >
        <button
          type="button"
          data-no-press
          aria-label="Drag or dismiss the panel"
          class="flex h-6 shrink-0 touch-none items-center justify-center"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <span class="h-1 w-9 rounded-[2px] bg-line-strong" />
        </button>
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </div>
    </Show>
  )
}

/** The panel as a non-modal drawer: it slides over the chat, keeps it live, and takes no scrim. */
export function RightDrawer(props: {
  open: boolean
  onClose: () => void
  label: string
  children: JSX.Element
}): JSX.Element {
  const { mounted, leaving } = createPresence(() => props.open, 200)
  escapeCloses(() => props.open, props.onClose)

  return (
    <Show when={mounted()}>
      <aside
        role="dialog"
        aria-label={props.label}
        class="fixed inset-y-0 right-0 z-30 flex w-[400px] flex-col border-l border-line-strong bg-surface shadow-[-8px_0_32px_rgba(0,0,0,0.5)] min-[1440px]:w-[440px]"
        classList={{ "slide-right": !leaving(), "slide-right-out": leaving() }}
      >
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </aside>
    </Show>
  )
}
