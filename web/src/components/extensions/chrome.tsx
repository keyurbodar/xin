import { Show, type JSX } from "solid-js"
import type { Remote, RowState } from "../../state/extensions.ts"
import { Glyph, type GlyphName } from "./glyph.tsx"

/** The message of a failed remote, so a Show can key on it without a callback over a boolean. */
export function failureOf(state: Remote<unknown>): string | undefined {
  return state.kind === "failed" ? state.message : undefined
}

export const INPUT =
  "h-8 w-full rounded-[2px] border border-line-inner bg-page px-2.5 text-[12.5px] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none"

export const MONO_INPUT =
  "h-8 w-full rounded-[2px] border border-line-inner bg-page px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none"

export type ButtonVariant = "default" | "primary" | "ghost" | "danger"

export function Button(props: {
  label: string
  onClick?: (() => void) | undefined
  icon?: GlyphName | undefined
  variant?: ButtonVariant | undefined
  disabled?: boolean | undefined
  title?: string | undefined
  type?: "button" | "submit" | undefined
  class?: string | undefined
}): JSX.Element {
  const variant = (): ButtonVariant => props.variant ?? "default"
  return (
    <button
      type={props.type ?? "button"}
      title={props.title}
      disabled={props.disabled === true}
      onClick={() => props.onClick?.()}
      class={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-2.5 text-[12.5px] font-medium transition-none disabled:opacity-40 ${props.class ?? ""}`}
      classList={{
        "border-accent bg-accent text-[#160700] hover:bg-accent": variant() === "primary",
        "border-line-inner bg-raised text-fg hover:border-line-strong hover:bg-hover": variant() === "default",
        "border-transparent bg-transparent text-fg-2 hover:text-fg": variant() === "ghost",
        "border-bad/40 bg-bad-bg text-bad hover:border-bad": variant() === "danger",
      }}
    >
      <Show when={props.icon}>
        {(icon) => <Glyph name={icon()} size={14} />}
      </Show>
      {props.label}
    </button>
  )
}

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

export function Pending(props: { label?: string | undefined }): JSX.Element {
  return <div class="px-3.5 py-6 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-4">{props.label ?? "Loading"}</div>
}

export function Failure(props: { message: string; onRetry?: (() => void) | undefined }): JSX.Element {
  return (
    <div class="flex items-start gap-3 rounded-[4px] border border-bad/30 bg-bad-bg px-3.5 py-3">
      <Glyph name="circle-x" size={14} class="mt-0.5 shrink-0 text-bad" />
      <span class="min-w-0 flex-1 text-[12.5px] text-fg-2">{props.message}</span>
      <Show when={props.onRetry}>
        {(retry) => <Button label="Retry" variant="ghost" onClick={retry()} />}
      </Show>
    </div>
  )
}

export function Empty(props: { title: string; detail?: string | undefined; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col items-start gap-2 rounded-[4px] border border-dashed border-line-inner px-4 py-6">
      <span class="text-[13px] text-fg-2">{props.title}</span>
      <Show when={props.detail}>
        {(detail) => <span class="text-[12px] leading-relaxed text-fg-3">{detail()}</span>}
      </Show>
      <Show when={props.children}>
        <span class="mt-1 flex items-center gap-2">{props.children}</span>
      </Show>
    </div>
  )
}

export function Note(props: { children: JSX.Element }): JSX.Element {
  return <p class="text-[11.5px] leading-relaxed text-fg-3">{props.children}</p>
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
