import type { JSX } from "solid-js"
import { For } from "solid-js"
import { STATE_COLOR, type VisualState } from "../../lib/status.ts"

const GROUPS: Readonly<Record<VisualState, readonly number[]>> = {
  queued: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  working: [0, 1, 2, 5, 8, 7, 6, 3],
  waiting: [4, 1, 5, 7, 3],
  done: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  failed: [0, 2, 4, 6, 8],
  paused: [0, 3, 6, 2, 5, 8],
  cancelled: [6, 4, 2],
}

const CELL = 2.5
const STEP = 4
const BASE = "#211d1b"

function cell(index: number, fill: string, cls?: string, delay?: number): JSX.Element {
  const x = CELL + (index % 3) * STEP
  const y = CELL + Math.floor(index / 3) * STEP
  return (
    <rect
      x={x}
      y={y}
      width={3}
      height={3}
      rx={0.6}
      fill={fill}
      class={cls}
      style={delay === undefined ? undefined : { "animation-delay": `${delay}s` }}
    />
  )
}

/** D Grid, the recommended family from I2: every state is its own pattern, legible at 12px in greyscale. */
export function StatusGlyph(props: { state: VisualState; size?: number; class?: string }): JSX.Element {
  const color = () => STATE_COLOR[props.state]
  const motion = (index: number, order: number): { cls: string; delay: number } => {
    switch (props.state) {
      case "queued":
        return { cls: "d-q", delay: index * 0.5 - 4.5 }
      case "working":
        return { cls: "d-w", delay: order * 0.12 - 0.96 }
      case "done":
        return { cls: "d-f", delay: index * 0.06 }
      case "cancelled":
        return { cls: "d-c", delay: order * 0.3 }
      case "waiting":
        return { cls: index === 4 ? "" : "d-p", delay: 0 }
      case "failed":
        return { cls: "d-x", delay: 0 }
      case "paused":
        return { cls: "d-pz", delay: 0 }
      default:
        return { cls: "", delay: 0 }
    }
  }
  return (
    <svg viewBox="0 0 16 16" width={props.size ?? 16} height={props.size ?? 16} class={props.class} aria-hidden="true">
      <For each={[0, 1, 2, 3, 4, 5, 6, 7, 8]}>{(index) => cell(index, BASE)}</For>
      <For each={GROUPS[props.state]}>
        {(index, order) => {
          const motionOf = motion(index, order())
          return cell(index, color(), motionOf.cls, motionOf.delay)
        }}
      </For>
    </svg>
  )
}

/** The state word in its own colour, mono, for dense rows. */
export function StateWord(props: { state: VisualState }): JSX.Element {
  return (
    <span class="font-mono text-[10px] uppercase tracking-[0.06em]" style={{ color: STATE_COLOR[props.state] }}>
      {props.state}
    </span>
  )
}
