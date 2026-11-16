import { ArrowUp, Square } from "lucide-solid"
import { Show, type JSX } from "solid-js"
import { Spinner } from "../ui/loaders.tsx"

/** Dimmed while there is nothing to send, Send (the card's submit) once there is, Stop while the run streams and the draft is empty. */
export function SendButton(props: {
  stop: boolean
  ready: boolean
  pending: boolean
  label: string
  onStop: () => void
}): JSX.Element {
  const state = (): string => (props.stop ? "stop" : props.ready ? "ready" : "idle")
  return (
    <button
      type={props.stop ? "button" : "submit"}
      onClick={(event) => {
        if (!props.stop) return
        event.preventDefault()
        props.onStop()
      }}
      disabled={props.pending || (!props.stop && !props.ready)}
      aria-label={props.stop ? "Stop the run" : props.label}
      data-state={state()}
      class="im-send grid h-[var(--h-control)] w-[var(--h-control)] shrink-0 place-items-center rounded-sm disabled:cursor-default"
    >
      <span class="im-swap im-swap-icon place-items-center">
        <span class="grid place-items-center" data-active={!props.pending && !props.stop ? "" : undefined}>
          <ArrowUp size={16} stroke-width={2} />
        </span>
        <span class="grid place-items-center" data-active={!props.pending && props.stop ? "" : undefined}>
          <Square size={11} stroke-width={0} fill="currentColor" />
        </span>
        <span class="grid place-items-center" data-active={props.pending ? "" : undefined}>
          <Show when={props.pending}>
            <Spinner />
          </Show>
        </span>
      </span>
    </button>
  )
}
