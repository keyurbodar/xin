import { Show, type JSX } from "solid-js"
import { Button } from "./button.tsx"
import { Icon } from "./icon.tsx"
import { Pictogram, type PictogramName } from "./pictogram.tsx"

export function EmptyState(props: {
  pictogram: PictogramName
  art?: JSX.Element | undefined
  title: string
  detail?: string | undefined
  action?: JSX.Element | undefined
}): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center px-6 py-10 text-center">
      <Show when={props.art} fallback={<Pictogram name={props.pictogram} size={88} />}>
        {props.art}
      </Show>
      <span class="mt-5 text-base font-medium text-ink-2">{props.title}</span>
      <Show when={props.detail}>
        <span class="mt-1.5 max-w-[270px] text-sm leading-[1.5] text-ink-3">{props.detail}</span>
      </Show>
      <Show when={props.action}>
        <span class="mt-4">{props.action}</span>
      </Show>
    </div>
  )
}

export function Empty(props: { title: string; detail?: string | undefined; children?: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col items-start gap-2 rounded-md border border-dashed border-line-2 px-4 py-6">
      <span class="text-base text-ink-2">{props.title}</span>
      <Show when={props.detail}>
        {(detail) => <span class="text-sm leading-relaxed text-ink-3">{detail()}</span>}
      </Show>
      <Show when={props.children}>
        <span class="mt-1 flex items-center gap-2">{props.children}</span>
      </Show>
    </div>
  )
}

export function Pending(props: { label?: string | undefined }): JSX.Element {
  return <div class="px-3.5 py-6 font-mono text-2xs uppercase tracking-[0.08em] text-icon">{props.label ?? "Loading"}</div>
}

export function Failure(props: { message: string; onRetry?: (() => void) | undefined }): JSX.Element {
  return (
    <div class="flex items-start gap-3 rounded-md border border-failed/30 bg-failed-soft px-3.5 py-3">
      <Icon name="circle-x" size={14} class="mt-0.5 shrink-0 text-failed" />
      <span class="min-w-0 flex-1 text-sm text-ink-2">{props.message}</span>
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
  return <p class="text-xs leading-relaxed text-ink-3">{props.children}</p>
}
