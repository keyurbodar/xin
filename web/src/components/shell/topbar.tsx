import { Show, type JSX } from "solid-js"
import { Button } from "../ui/button.tsx"

export function TopBar(props: { title: string; subtitle?: string; leading?: JSX.Element; actions?: JSX.Element }): JSX.Element {
  return (
    <header class="flex h-13 shrink-0 items-center gap-2.5 border-b border-line px-4">
      <Show when={props.leading}>{props.leading}</Show>
      <h1 class="truncate text-[15px] font-medium text-fg">{props.title}</h1>
      <Show when={props.subtitle}>
        <span class="hidden truncate text-[12.5px] text-fg-3 sm:inline">{props.subtitle}</span>
      </Show>
      <div class="ml-auto flex items-center gap-2">{props.actions}</div>
    </header>
  )
}

export function TopButton(props: {
  icon?: JSX.Element
  label: string
  primary?: boolean
  shortcut?: string
  onClick?: () => void
}): JSX.Element {
  return (
    <Button size="sm" variant={props.primary === true ? "primary" : "ghost"} onClick={props.onClick}>
      <Show when={props.icon}>{props.icon}</Show>
      {props.label}
      <Show when={props.shortcut}>
        <span
          class="kbd ml-0.5 px-1 leading-4"
          classList={{ "border-ink/30 text-ink": props.primary === true, "text-fg-3": props.primary !== true }}
        >
          {props.shortcut}
        </span>
      </Show>
    </Button>
  )
}
