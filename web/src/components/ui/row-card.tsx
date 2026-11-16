import { Box, CircleDashed, Laptop, Sparkles } from "lucide-solid"
import { For, Show, type JSX } from "solid-js"
import { HoverCard } from "./hover-card.tsx"

export type RowCardIssue = { readonly key: string; readonly title: string; readonly href: string }

const ICON = { size: 14, "stroke-width": 1.5 } as const

/** The sidebar row's hover card: code and shortcut, title, where it runs, and its linked issues. */
export function RowCard(props: {
  trigger: JSX.Element
  code: string
  title: string
  project: string
  shortcut?: string | undefined
  machine?: string | undefined
  model?: string | undefined
  mark?: JSX.Element
  issues?: readonly RowCardIssue[] | undefined
}): JSX.Element {
  return (
    <HoverCard trigger={props.trigger} side="right" align="start" class="w-[340px]">
      <div class="flex flex-col gap-1 px-2 pb-2 pt-1.5">
        <div class="flex h-6 items-center gap-2 text-mini text-ink-3">
          {props.mark}
          <span class="truncate">{props.code}</span>
          <Show when={props.shortcut}>{(shortcut) => <span class="kbd ml-auto">{shortcut()}</span>}</Show>
        </div>
        <p class="line-clamp-2 text-body font-title text-ink">{props.title}</p>
        <div class="flex min-w-0 items-center gap-3 text-mini text-ink-3">
          <Meta icon={<Box {...ICON} />} label={props.project} />
          <Show when={props.machine}>{(machine) => <Meta icon={<Laptop {...ICON} />} label={machine()} />}</Show>
          <Show when={props.model}>{(model) => <Meta icon={<Sparkles {...ICON} />} label={model()} />}</Show>
        </div>
      </div>
      <Show when={props.issues !== undefined && props.issues.length > 0}>
        <div class="border-t border-line-1 pt-1">
          <span class="block px-2 pb-1 pt-1.5 text-mini font-title text-ink-3">Issues</span>
          <For each={props.issues}>
            {(issue) => (
              <a
                href={issue.href}
                class="im-hover im-focus flex h-[var(--h-row)] min-w-0 items-center gap-2 rounded-sm px-2 text-small"
              >
                <span class="shrink-0 text-ink-3">
                  <CircleDashed {...ICON} />
                </span>
                <span class="shrink-0 text-ink-3">{issue.key}</span>
                <span class="truncate text-ink">{issue.title}</span>
              </a>
            )}
          </For>
        </div>
      </Show>
    </HoverCard>
  )
}

function Meta(props: { icon: JSX.Element; label: string }): JSX.Element {
  return (
    <span class="flex min-w-0 items-center gap-1">
      <span class="shrink-0">{props.icon}</span>
      <span class="truncate">{props.label}</span>
    </span>
  )
}
