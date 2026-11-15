import { Show, type JSX } from "solid-js"
import { ArrowLeft, ArrowRight } from "lucide-solid"
import { Spinner } from "../ui/loaders.tsx"

export function StepCard(props: { step: string; title: string; intro: string; width: string; children: JSX.Element }): JSX.Element {
  return (
    <section class={`im-arrive w-full ${props.width} rounded-lg border border-line-1 bg-card px-7 pb-7 pt-6`}>
      <p class="text-sm text-ink-3">{props.step}</p>
      <h1 class="mt-1.5 text-2xl font-semibold tracking-[-0.02em]">{props.title}</h1>
      <p class="mt-2 text-base leading-5 text-ink-2">{props.intro}</p>
      <div class="mt-6 flex flex-col gap-5">{props.children}</div>
    </section>
  )
}

export function PrimaryButton(props: {
  label: string
  busy?: boolean
  disabled?: boolean
  wide?: boolean
  type?: "button" | "submit"
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled === true || props.busy === true}
      aria-busy={props.busy === true}
      onClick={() => props.onClick?.()}
      class="im-press inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-base font-medium text-on-accent enabled:hover:brightness-110 disabled:opacity-50"
      classList={{ "h-9 w-full": props.wide === true, "h-8": props.wide !== true }}
    >
      <Show when={props.busy === true}>
        <Spinner size={14} />
      </Show>
      {props.label}
      <Show when={props.busy !== true}>
        <ArrowRight size={14} stroke-width={1.75} aria-hidden="true" />
      </Show>
    </button>
  )
}

export function QuietButton(props: { label: string; back?: boolean; disabled?: boolean; onClick?: () => void }): JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled === true}
      onClick={() => props.onClick?.()}
      class="im-press im-hover inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-base text-ink-2 disabled:opacity-50"
    >
      <Show when={props.back === true}>
        <ArrowLeft size={14} stroke-width={1.75} aria-hidden="true" />
      </Show>
      {props.label}
    </button>
  )
}

export function Field(props: { label: string; aside?: string; hint?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <span class="flex items-baseline justify-between text-sm font-medium text-ink-2">
        {props.label}
        <Show when={props.aside !== undefined}>
          <span class="font-normal text-ink-3">{props.aside}</span>
        </Show>
      </span>
      {props.children}
      <Show when={props.hint !== undefined}>
        <span class="text-sm text-ink-3">{props.hint}</span>
      </Show>
    </div>
  )
}

export const INPUT_BOX =
  "flex h-9 items-center gap-2 rounded-md border bg-panel px-3 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-[3px] focus-within:ring-primary-soft"

export function TextInput(props: {
  value: string
  onInput: (value: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  invalid?: boolean
  maxLength?: number
  ariaLabel: string
  autofocus?: boolean
  leading?: JSX.Element
  trailing?: JSX.Element
}): JSX.Element {
  return (
    <div class={INPUT_BOX} classList={{ "border-failed": props.invalid === true, "border-line-2": props.invalid !== true }}>
      {props.leading}
      <input
        type="text"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        placeholder={props.placeholder}
        autocomplete="off"
        spellcheck={false}
        disabled={props.disabled === true}
        maxLength={props.maxLength}
        aria-label={props.ariaLabel}
        aria-invalid={props.invalid === true}
        autofocus={props.autofocus === true}
        class="h-full min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-placeholder focus:outline-none disabled:opacity-60"
        classList={{ "font-mono": props.mono === true }}
      />
      {props.trailing}
    </div>
  )
}

export function StatusLine(props: { tone: "error" | "ok" | "muted"; text: string | undefined }): JSX.Element {
  return (
    <Show when={props.text !== undefined && props.text !== ""}>
      <p
        class="im-event text-sm"
        classList={{
          "text-failed": props.tone === "error",
          "text-done-text": props.tone === "ok",
          "text-ink-3": props.tone === "muted",
        }}
        role={props.tone === "error" ? "alert" : "status"}
      >
        {props.text}
      </p>
    </Show>
  )
}
