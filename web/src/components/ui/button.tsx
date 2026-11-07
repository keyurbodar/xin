import type { JSX } from "solid-js"

export type ButtonVariant = "primary" | "ghost" | "quiet" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

const BASE =
  "inline-flex items-center justify-center whitespace-nowrap rounded-[2px] font-medium transition-none disabled:opacity-40"

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-7 gap-1.5 px-2.5 text-[12.5px]",
  md: "h-10 gap-2 px-3.5 text-[13.5px]",
  lg: "h-11 gap-2 px-4 text-[14.5px]",
}

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "border border-accent bg-accent text-ink hover:opacity-90",
  ghost: "border border-line-inner bg-raised text-fg hover:border-line-strong hover:bg-hover",
  quiet: "border border-transparent bg-transparent text-fg-2 hover:text-fg",
  danger: "border border-bad/40 bg-bad-bg text-bad hover:border-bad",
}

export function Button(props: {
  variant?: ButtonVariant | undefined
  size?: ButtonSize | undefined
  disabled?: boolean | undefined
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
      onClick={() => props.onClick?.()}
      class={`${BASE} ${SIZES[size()]} ${VARIANTS[variant()]} ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  )
}
