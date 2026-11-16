import "@ui-sdk/web/hover-card"
import { Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js"
import { POPUP } from "./surface.ts"

const OPEN_DELAY = 400
const CLOSE_DELAY = 150
const WARM_FOR = 300
const DWELL = 100

const [warm, setWarm] = createSignal(false)
let showing = 0
let cooling: ReturnType<typeof setTimeout> | undefined

function shown(): void {
  showing += 1
  clearTimeout(cooling)
  setWarm(true)
}

function hidden(): void {
  showing = Math.max(0, showing - 1)
  if (showing > 0) return
  cooling = setTimeout(() => setWarm(false), WARM_FOR)
}

/**
 * A preview on UI SDK's Hover Card: it opens after the pointer rests 400ms on the trigger or keyboard focus reaches it,
 * closes 150ms after the pointer leaves or on Escape, and opens at once without animating while another card is open or
 * was a moment ago. `children` mount on the first open and stay. While open, the trigger's link or button is described by
 * the card. `onSettle` runs once the card is open and the pointer or focus rests on the trigger or the card: at once after
 * the open delay, or after a short dwell for a warm opening, so a pointer sweeping across triggers settles none of them.
 */
export function HoverCard(props: {
  trigger: JSX.Element
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  class?: string
  onSettle?: () => void
  children: JSX.Element
}): JSX.Element {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [instant, setInstant] = createSignal(false)
  const [seen, setSeen] = createSignal(false)
  let trigger: HTMLElement | undefined
  let content: HTMLElement | undefined
  let dwell: ReturnType<typeof setTimeout> | undefined
  let held = false
  const hold = (next: boolean): void => {
    if (next === held) return
    held = next
    if (next) shown()
    else hidden()
  }
  const resting = (): boolean =>
    trigger?.querySelector("a[href], button")?.matches(":hover, :focus") === true || content?.matches(":hover") === true
  const settle = (): void => {
    dwell = setTimeout(() => {
      if (!open()) return
      if (resting()) props.onSettle?.()
      else settle()
    }, DWELL)
  }
  onCleanup(() => {
    clearTimeout(dwell)
    hold(false)
  })
  createEffect(() => {
    const link = trigger?.querySelector("a[href], button")
    if (open()) link?.setAttribute("aria-describedby", id)
    else link?.removeAttribute("aria-describedby")
  })
  return (
    <ui-hover-card
      class="contents"
      delay={warm() ? 0 : OPEN_DELAY}
      attr:close-delay={CLOSE_DELAY}
      on:openchange={(event) => {
        if (event.defaultPrevented || event.detail.value === open()) return
        const next = event.detail.value
        const wasWarm = warm()
        if (next) setInstant(wasWarm)
        hold(next)
        setOpen(next)
        if (next) setSeen(true)
        clearTimeout(dwell)
        if (!next) return
        if (wasWarm) settle()
        else props.onSettle?.()
      }}
    >
      <ui-hover-card-trigger ref={trigger}>{props.trigger}</ui-hover-card-trigger>
      <ui-hover-card-content
        ref={content}
        id={id}
        side={props.side ?? "bottom"}
        align={props.align ?? "start"}
        side-offset="6"
        collision-padding="8"
        attr:data-warm={instant() ? "" : undefined}
        class={`${POPUP} ${props.class ?? "w-[320px]"} max-w-[calc(100vw-16px)]`}
      >
        <Show when={seen()}>{props.children}</Show>
      </ui-hover-card-content>
    </ui-hover-card>
  )
}
