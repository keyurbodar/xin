import { Show, type JSX } from "solid-js"
import type { Remote, RowState } from "../../state/extensions.ts"

export { Button } from "../ui/button.tsx"
export type { ButtonVariant } from "../ui/button.tsx"
export { Empty, Failure, Note, Pending } from "../ui/state.tsx"

export function failureOf(state: Remote<unknown>): string | undefined {
  return state.kind === "failed" ? state.message : undefined
}

export const INPUT =
  "h-8 w-full rounded-[2px] border border-line-inner bg-page px-2.5 text-[12.5px] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none"

export const MONO_INPUT =
  "h-8 w-full rounded-[2px] border border-line-inner bg-page px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none"

export type ChipTone = "default" | "accent" | "ok" | "bad" | "warn" | "working"

export function Chip(props: { children: JSX.Element; tone?: ChipTone | undefined; class?: string | undefined }): JSX.Element {
  const tone = (): ChipTone => props.tone ?? "default"
  return (
    <span
      class={`inline-flex w-max items-center gap-1 rounded-[2px] border px-1 py-px font-mono text-[9.5px] font-medium uppercase tracking-[0.06em] ${props.class ?? ""}`}
      classList={{
        "border-line-inner text-fg-3": tone() === "default",
        "border-accent-line bg-accent-dim text-accent-text": tone() === "accent",
        "border-ok/30 bg-ok-bg text-ok": tone() === "ok",
        "border-bad/30 bg-bad-bg text-bad": tone() === "bad",
        "border-warn/30 bg-warn-bg text-warn": tone() === "warn",
        "border-working/30 bg-working/10 text-working": tone() === "working",
      }}
    >
      {props.children}
    </span>
  )
}

const STATE_TONE: Readonly<Record<RowState["kind"], ChipTone>> = {
  active: "ok",
  pending: "default",
  disabled: "default",
  failed: "bad",
  missing: "bad",
}

const STATE_WORD: Readonly<Record<RowState["kind"], string>> = {
  active: "Running",
  pending: "Pending",
  disabled: "Off",
  failed: "Failed",
  missing: "Missing",
}

export function StateChip(props: { state: RowState }): JSX.Element {
  return <Chip tone={STATE_TONE[props.state.kind]}>{STATE_WORD[props.state.kind]}</Chip>
}

export function Toggle(props: {
  on: boolean
  disabled?: boolean | undefined
  label: string
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled === true}
      onClick={() => props.onChange(!props.on)}
      class="relative h-4 w-7 shrink-0 rounded-[2px] transition-none disabled:opacity-40"
      classList={{ "bg-fg": props.on, "bg-line-inner": !props.on }}
    >
      <span
        class="absolute top-0.5 h-3 w-3 rounded-[1px] bg-page"
        classList={{ "left-3.5": props.on, "left-0.5 bg-fg-3": !props.on }}
      />
    </button>
  )
}

export function Panel(props: { children: JSX.Element; class?: string | undefined }): JSX.Element {
  return <div class={`overflow-hidden rounded-[4px] border border-line bg-surface ${props.class ?? ""}`}>{props.children}</div>
}

export function MissingOp(props: { op: string; detail?: string | undefined }): JSX.Element {
  return (
    <div class="flex flex-wrap items-baseline gap-2 text-[11.5px] text-fg-3">
      <span class="mono-meta">Not in this build</span>
      <span class="mono-meta text-fg-2">{props.op}</span>
      <Show when={props.detail}>
        {(detail) => <span class="text-[11.5px] text-fg-3">{detail()}</span>}
      </Show>
    </div>
  )
}
