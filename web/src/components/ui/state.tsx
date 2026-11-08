import { Show, type JSX } from "solid-js"
import { Button } from "./button.tsx"
import { Icon } from "./icon.tsx"
import { Pictogram, type PictogramName } from "./pictogram.tsx"

export function EmptyState(props: {
  pictogram: PictogramName
  title: string
  detail?: string | undefined
  action?: JSX.Element | undefined
}): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center px-6 py-10 text-center">
      <Pictogram name={props.pictogram} size={88} />
      <span class="mt-5 text-[13.5px] font-medium text-fg-2">{props.title}</span>
      <Show when={props.detail}>
        <span class="mt-1.5 max-w-[270px] text-[13px] leading-[1.5] text-fg-3">{props.detail}</span>
      </Show>
      <Show when={props.action}>
        <span class="mt-4">{props.action}</span>
      </Show>
    </div>
  )
}

export function Empty(props: { title: string; detail?: string | undefined; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col items-start gap-2 rounded-[12px] border border-dashed border-line-inner px-4 py-6">
      <span class="text-[13.5px] text-fg-2">{props.title}</span>
      <Show when={props.detail}>
        {(detail) => <span class="text-[12.5px] leading-relaxed text-fg-3">{detail()}</span>}
      </Show>
      <Show when={props.children}>
        <span class="mt-1 flex items-center gap-2">{props.children}</span>
      </Show>
    </div>
  )
}

export const ANSWER_CHIP =
  "inline-flex min-h-[26px] items-center rounded-[6px] border border-line-inner bg-fill px-2.5 py-0.5 text-[12.5px] text-fg hover:bg-selected disabled:opacity-50"

export function Pending(props: { label?: string | undefined }): JSX.Element {
  return <div class="px-3.5 py-6 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-4">{props.label ?? "Loading"}</div>
}

export function Failure(props: { message: string; onRetry?: (() => void) | undefined }): JSX.Element {
  return (
    <div class="flex items-start gap-3 rounded-[12px] border border-bad/30 bg-bad-bg px-3.5 py-3">
      <Icon name="circle-x" size={14} class="mt-0.5 shrink-0 text-bad" />
      <span class="min-w-0 flex-1 text-[13px] text-fg-2">{props.message}</span>
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
