import type { JSX } from "solid-js"
import { For } from "solid-js"
import type { VisualState } from "../../lib/status.ts"

const SIGNAL: Readonly<Record<VisualState, string>> = {
  queued: "queued",
  working: "working",
  waiting: "needs",
  done: "done",
  failed: "failed",
  paused: "waiting",
  cancelled: "idle",
}

const DOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

/** Signal, the 3×3 D-Grid from ingle-motion.css: every state is its own pattern, and a change morphs dot by dot. */
export function StatusGlyph(props: { state: VisualState; size?: 12 | 14 | 16 | 20; class?: string }): JSX.Element {
  return (
    <span
      class={`sig ${props.class ?? ""}`}
      data-state={SIGNAL[props.state]}
      data-size={props.size === 14 ? undefined : (props.size ?? 16)}
      aria-hidden="true"
    >
      <For each={DOTS}>{() => <i />}</For>
    </span>
  )
}
