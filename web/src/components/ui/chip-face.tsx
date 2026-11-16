import type { LucideProps } from "lucide-solid"
import type { Component, JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

export const CHIP_ICON = { size: 14, "stroke-width": 1.5 } as const

const CHIP =
  "im-focus inline-flex max-w-full items-baseline gap-1 rounded-xs text-primary-ink no-underline decoration-primary-ink/40 underline-offset-2 hover:underline"

export function ChipFace(props: {
  href: string
  kind: string
  label: string
  tone: string
  icon: Component<LucideProps>
  mono: boolean
}): JSX.Element {
  return (
    <a href={props.href} class={CHIP} data-kind={props.kind}>
      <span class={`shrink-0 self-center ${props.tone}`}>
        <Dynamic component={props.icon} {...CHIP_ICON} />
      </span>
      <span class={`truncate ${props.mono ? "font-mono" : ""}`}>{props.label}</span>
    </a>
  )
}
