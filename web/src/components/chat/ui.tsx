import { Show, type JSX } from "solid-js"
import { Icon, type IconName } from "../ui/icon.tsx"

export function Button(props: {
  variant?: "solid" | "ghost" | "primary"
  disabled?: boolean
  onClick?: () => void
  children: JSX.Element
  class?: string
}): JSX.Element {
  const variant = (): "solid" | "ghost" | "primary" => props.variant ?? "solid"
  return (
    <button
      type="button"
      disabled={props.disabled === true}
      onClick={() => props.onClick?.()}
      class={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-2.5 text-[12.5px] font-medium transition-none disabled:opacity-50 ${props.class ?? ""}`}
      classList={{
        "border border-accent bg-accent text-[#160700] hover:opacity-90": variant() === "primary",
        "border border-line-inner bg-hover text-fg hover:border-line-strong": variant() === "solid",
        "text-fg-2 hover:text-fg": variant() === "ghost",
      }}
    >
      {props.children}
    </button>
  )
}

export function EmptyState(props: {
  icon: IconName
  title: string
  detail?: string
  action?: JSX.Element
}): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span class="grid h-9 w-9 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-3">
        <Icon name={props.icon} size={16} />
      </span>
      <div class="flex flex-col gap-1">
        <span class="text-[13px] text-fg-2">{props.title}</span>
        <Show when={props.detail}>
          <span class="max-w-[280px] text-[12px] leading-[1.5] text-fg-3">{props.detail}</span>
        </Show>
      </div>
      <Show when={props.action}>{props.action}</Show>
    </div>
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
