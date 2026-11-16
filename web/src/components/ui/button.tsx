import type { JSX } from "solid-js"

export type ButtonVariant = "primary" | "ghost" | "quiet" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

const BASE =
  "inline-flex items-center justify-center whitespace-nowrap rounded-sm font-medium disabled:opacity-40"

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-7 gap-1.5 px-2.5 text-sm",
  md: "h-10 gap-2 px-3.5 text-base",
  lg: "h-11 gap-2 px-4 text-base",
}

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "border border-primary bg-primary text-on-primary hover:opacity-90",
  ghost: "border border-line-2 bg-card text-ink hover:border-line-3 hover:bg-secondary",
  quiet: "border border-transparent bg-transparent text-ink-2 hover:text-ink",
  danger: "border border-failed/40 bg-failed-soft text-failed hover:border-failed",
}

export function Button(props: {
  variant?: ButtonVariant | undefined
  size?: ButtonSize | undefined
  disabled?: boolean | undefined
  /** Working: the button keeps focus and its place in the tab order, but ignores presses. */
  busy?: boolean | undefined
  /** Unavailable without losing focus, unlike `disabled`: for a button that turns off while it is pressed. */
  idle?: boolean | undefined
  onClick?: (() => void) | undefined
  type?: "button" | "submit" | undefined
  class?: string | undefined
  children: JSX.Element
}): JSX.Element {
  const variant = (): ButtonVariant => props.variant ?? "ghost"
  const size = (): ButtonSize => props.size ?? "md"
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled === true}
      aria-busy={props.busy === true ? "true" : undefined}
      aria-disabled={props.busy === true || props.idle === true ? "true" : undefined}
      onClick={() => {
        if (props.busy !== true && props.idle !== true) props.onClick?.()
      }}
      class={`${BASE} aria-disabled:opacity-40 aria-busy:cursor-progress aria-busy:opacity-70 ${SIZES[size()]} ${VARIANTS[variant()]} ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  )
}
