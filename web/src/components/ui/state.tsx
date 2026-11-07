import { Show, type JSX } from "solid-js"
import { Button } from "./button.tsx"
import { Icon, type IconName } from "./icon.tsx"

export function EmptyState(props: {
  icon: IconName
  title: string
  detail?: string | undefined
  action?: JSX.Element | undefined
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

export function Empty(props: { title: string; detail?: string | undefined; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col items-start gap-2 rounded-[4px] border border-dashed border-line-inner px-4 py-6">
      <span class="text-[13px] text-fg-2">{props.title}</span>
      <Show when={props.detail}>
        {(detail) => <span class="text-[12px] leading-relaxed text-fg-3">{detail()}</span>}
      </Show>
      <Show when={props.children}>
        <span class="mt-1 flex items-center gap-2">{props.children}</span>
      </Show>
    </div>
  )
}

export function Pending(props: { label?: string | undefined }): JSX.Element {
  return <div class="px-3.5 py-6 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-4">{props.label ?? "Loading"}</div>
}

export function Failure(props: { message: string; onRetry?: (() => void) | undefined }): JSX.Element {
  return (
    <div class="flex items-start gap-3 rounded-[4px] border border-bad/30 bg-bad-bg px-3.5 py-3">
      <Icon name="circle-x" size={14} class="mt-0.5 shrink-0 text-bad" />
      <span class="min-w-0 flex-1 text-[12.5px] text-fg-2">{props.message}</span>
      <Show when={props.onRetry}>
        {(retry) => (
          <Button variant="quiet" size="sm" onClick={retry()}>
            Retry
          </Button>
        )}
      </Show>
    </div>
  )
}

export function Note(props: { children: JSX.Element }): JSX.Element {
  return <p class="text-[11.5px] leading-relaxed text-fg-3">{props.children}</p>
}
