import { Show, type JSX } from "solid-js"
import type { Remote, RowState } from "../../state/extensions.ts"

export { Button } from "../ui/button.tsx"
export type { ButtonVariant } from "../ui/button.tsx"
export { Empty, Failure, Note, Pending } from "../ui/state.tsx"

export function failureOf(state: Remote<unknown>): string | undefined {
  return state.kind === "failed" ? state.message : undefined
}

export const INPUT =
  "h-8 w-full rounded-sm border border-line-2 bg-bg px-2.5 text-sm text-ink placeholder:text-icon focus:border-line-3 focus:outline-none"

export const MONO_INPUT =
  "h-8 w-full rounded-sm border border-line-2 bg-bg px-2.5 font-mono text-sm text-ink placeholder:text-icon focus:border-line-3 focus:outline-none"

export type ChipTone = "default" | "accent" | "ok" | "bad" | "warn" | "working"

export function Chip(props: { children: JSX.Element; tone?: ChipTone | undefined; class?: string | undefined }): JSX.Element {
  const tone = (): ChipTone => props.tone ?? "default"
  return (
    <span
      class={`inline-flex w-max items-center gap-1 rounded-sm border px-1 py-px font-mono text-2xs font-medium uppercase tracking-[0.06em] ${props.class ?? ""}`}
      classList={{
        "border-line-2 text-ink-3": tone() === "default",
        "border-primary/40 bg-primary-soft text-primary-ink": tone() === "accent",
        "border-done/30 bg-done-soft text-done": tone() === "ok",
        "border-failed/30 bg-failed-soft text-failed": tone() === "bad",
        "border-working/30 bg-working-soft text-working": tone() === "warn",
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
      class="im-switch relative h-4 w-7 shrink-0 rounded-sm disabled:opacity-40"
      classList={{ "bg-ink": props.on, "bg-line-2": !props.on }}
    >
      <i class="absolute left-0.5 top-0.5 h-3 w-3 rounded-2xs bg-bg" classList={{ "bg-ink-3": !props.on }} />
    </button>
  )
}

export function Panel(props: { children: JSX.Element; class?: string | undefined }): JSX.Element {
  return <div class={`overflow-hidden rounded-md border border-line-1 bg-panel ${props.class ?? ""}`}>{props.children}</div>
}
