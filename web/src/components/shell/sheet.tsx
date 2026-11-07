import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"

/**
 * M3: a panel or menu arriving from the bottom on a narrow screen. Drag the handle up for full
 * height, down to dismiss; Escape and the scrim close it. The sheet itself never scrolls its own
 * header away, so the handle stays grabbable.
 */
export function BottomSheet(props: {
  open: boolean
  onClose: () => void
  label: string
  children: JSX.Element
}): JSX.Element {
  const [offset, setOffset] = createSignal(0)
  const [full, setFull] = createSignal(false)
  let start: number | undefined

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && props.open) props.onClose()
  }

  onMount(() => {
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

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
    <Show when={props.open}>
      <div class="fixed inset-0 z-40 bg-black/64 min-[1280px]:hidden" onMouseDown={props.onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        class="enter-sheet fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[8px] border-t border-line-strong bg-raised min-[1280px]:hidden"
        style={{
          height: full() ? "calc(100% - 24px)" : "76%",
          transform: offset() > 0 ? `translateY(${offset()}px)` : undefined,
          transition: start === undefined ? "transform 200ms var(--ease-standard), height 200ms var(--ease-standard)" : "none",
        }}
      >
        <button
          type="button"
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
