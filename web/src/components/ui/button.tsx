import type { JSX } from "solid-js"

export type ButtonVariant = "primary" | "ghost" | "quiet" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] font-medium transition-[background-color,color,border-color,transform] duration-[120ms] ease-[var(--ease-kiko)] outline-none active:scale-[0.975] disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100"

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-7 px-2.5 text-[12.5px]",
  md: "h-8 px-3.5 text-[14px]",
  lg: "h-12 px-5 text-[15px]",
}

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-accent text-ink shadow-[inset_0_var(--hl-y)_0_0_var(--color-hl-primary)] hover:bg-accent/90 active:bg-accent/80",
  ghost:
    "border border-line bg-fill text-fg/80 shadow-[inset_0_var(--hl-y)_0_0_var(--hl-top),0_0_0_0.5px_var(--color-ring-crisp)] hover:bg-fill-strong hover:text-fg active:bg-hover",
  quiet: "text-fg-2 hover:bg-hover hover:text-fg",
  danger: "border border-bad/25 bg-bad-bg text-bad hover:bg-bad/20",
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
