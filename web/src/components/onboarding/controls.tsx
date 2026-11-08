import { Show, type JSX } from "solid-js"
import { Button } from "../ui/button.tsx"

export function Spinner(props: { tone?: "dark" | "light" }): JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" class={props.tone === "light" ? "text-fg-2" : "text-ink"}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.6" />
      <g class="spinner-arc">
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </g>
    </svg>
  )
}

export function PrimaryButton(props: {
  label: string
  busy?: boolean
  disabled?: boolean
  icon?: JSX.Element
  onClick?: () => void
}): JSX.Element {
  return (
    <Button
      variant="primary"
      size="md"
      disabled={props.disabled === true || props.busy === true}
      onClick={props.onClick}
    >
      <Show when={props.busy === true}>
        <Spinner />
      </Show>
      <Show when={props.busy !== true}>{props.icon}</Show>
      {props.label}
    </Button>
  )
}

export function GhostButton(props: { label: string; onClick?: () => void; disabled?: boolean }): JSX.Element {
  return (
    <Button variant="quiet" size="md" disabled={props.disabled === true} onClick={props.onClick}>
      {props.label}
    </Button>
  )
}

export function StepHeading(props: { step: string; title: string; intro: string }): JSX.Element {
  return (
    <div class="flex flex-col gap-2.5">
      <span class="label">{props.step}</span>
      <h1 class="text-[28px] font-light leading-[1.15] tracking-[-0.03em] md:text-[32px]">{props.title}</h1>
      <p class="max-w-[520px] text-[13.5px] leading-[1.6] text-fg-3">{props.intro}</p>
    </div>
  )
}

export function Field(props: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-[12px] font-medium text-fg-2">{props.label}</span>
      {props.children}
      <Show when={props.hint !== undefined}>
        <span class="text-[12px] leading-[1.5] text-fg-3">{props.hint}</span>
      </Show>
    </div>
  )
}

export function TextInput(props: {
  value: string
  onInput: (value: string) => void
  placeholder?: string
  type?: "text" | "password"
  mono?: boolean
  disabled?: boolean
  autocomplete?: string
  ariaLabel?: string
  onEnter?: () => void
  leading?: JSX.Element
  trailing?: JSX.Element
}): JSX.Element {
  return (
    <div class="flex h-10 items-center gap-2 rounded-[2px] border border-line-inner bg-surface px-3 focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(255,90,0,0.18)]">
      {props.leading}
      <input
        type={props.type ?? "text"}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && props.onEnter !== undefined) {
            event.preventDefault()
            props.onEnter()
          }
        }}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete ?? "off"}
        spellcheck={false}
        disabled={props.disabled === true}
        aria-label={props.ariaLabel}
        class="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-fg placeholder:text-fg-4 focus:outline-none disabled:opacity-60"
        classList={{ "font-mono text-[12.5px]": props.mono === true }}
      />
      {props.trailing}
    </div>
  )
}

export function TextArea(props: {
  value: string
  onInput: (value: string) => void
  placeholder?: string
  rows?: number
  ariaLabel?: string
}): JSX.Element {
  return (
    <textarea
      value={props.value}
      onInput={(event) => props.onInput(event.currentTarget.value)}
      placeholder={props.placeholder}
      rows={props.rows ?? 3}
      spellcheck={false}
      aria-label={props.ariaLabel}
      class="min-h-[84px] w-full resize-none rounded-[2px] border border-line-inner bg-surface px-3 py-2.5 text-[13.5px] leading-[1.55] text-fg placeholder:text-fg-4 focus:border-accent focus:shadow-[0_0_0_3px_rgba(255,90,0,0.18)] focus:outline-none"
    />
  )
}

export function StatusLine(props: { tone: "error" | "ok" | "muted"; text?: string | undefined }): JSX.Element {
  return (
    <p
      class="min-h-4 text-[12px] leading-4"
      classList={{
        "text-bad": props.tone === "error",
        "text-ok": props.tone === "ok",
        "text-fg-3": props.tone === "muted",
      }}
      role={props.tone === "error" ? "alert" : undefined}
    >
      {props.text ?? ""}
    </p>
  )
}
