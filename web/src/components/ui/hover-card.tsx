import "@ui-sdk/web/hover-card"
import { Show, createSignal, type JSX } from "solid-js"
import { POPUP } from "./surface.ts"

const OPEN_DELAY = 400
const CLOSE_DELAY = 150
const WARM_FOR = 300

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
 * was a moment ago. `children` mount on the first open and stay, so a loader inside runs once.
 */
export function HoverCard(props: {
  trigger: JSX.Element
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  class?: string
  children: JSX.Element
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [instant, setInstant] = createSignal(false)
  const [seen, setSeen] = createSignal(false)
  return (
    <ui-hover-card
      class="contents"
      delay={warm() ? 0 : OPEN_DELAY}
      close-delay={CLOSE_DELAY}
      on:openchange={(event) => {
        if (event.defaultPrevented || event.detail.value === open()) return
        if (event.detail.value) {
          setInstant(warm())
          shown()
        } else hidden()
        setOpen(event.detail.value)
        if (event.detail.value) setSeen(true)
      }}
    >
      <ui-hover-card-trigger>{props.trigger}</ui-hover-card-trigger>
      <ui-hover-card-content
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
