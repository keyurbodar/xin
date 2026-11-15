import type { JSX } from "solid-js"
import { STATE_WORD, type SignalState } from "../../lib/status.ts"

export type SignalSize = 12 | 14 | 16 | 20

export function Signal(props: { state: SignalState; size?: SignalSize; class?: string }): JSX.Element {
  return (
    <span
      class={`sig ${props.class ?? ""}`}
      data-state={props.state}
      data-size={props.size ?? 14}
      role="img"
      aria-label={STATE_WORD[props.state]}
    >
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
