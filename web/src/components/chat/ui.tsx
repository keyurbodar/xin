import type { JSX } from "solid-js"
import { Button as SharedButton } from "../ui/button.tsx"

export { EmptyState } from "../ui/state.tsx"

export function Button(props: {
  variant?: "solid" | "ghost" | "primary"
  disabled?: boolean
  onClick?: () => void
  children: JSX.Element
  class?: string
}): JSX.Element {
  return (
    <SharedButton
      size="sm"
      variant={props.variant === "primary" ? "primary" : props.variant === "ghost" ? "quiet" : "ghost"}
      disabled={props.disabled}
      onClick={props.onClick}
      class={props.class}
    >
      {props.children}
    </SharedButton>
  )
}

export function Spinner(props: { class?: string }): JSX.Element {
  return (
    <span
      class={`inline-block h-3.5 w-3.5 animate-spin rounded-full border border-line-inner border-t-fg-2 ${props.class ?? ""}`}
      aria-label="Working"
    />
  )
}

/** Ghost rows for a panel list: the same row height and gutters as the real rows, so nothing shifts when data lands. */
export function PanelGhost(props: { rows: number }): JSX.Element {
  return (
    <div class="flex flex-col">
      {Array.from({ length: props.rows }, (_, index) => (
        <div class="flex h-11 items-center gap-2.5 border-b border-line px-3">
          <span class="h-4 w-4 shrink-0 rounded-[2px] border border-line-inner bg-raised" />
          <span class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="h-2.5 rounded-[1px] bg-hover" style={{ width: `${54 + (index % 3) * 12}%` }} />
            <span class="h-2 rounded-[1px] bg-hover" style={{ width: `${28 + (index % 4) * 8}%` }} />
          </span>
          <span class="h-2 w-6 rounded-[1px] bg-hover" />
        </div>
      ))}
    </div>
  )
}
