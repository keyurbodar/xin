import type { JSX } from "solid-js"

/** What an ErrorBoundary shows in place of the part that failed: the error and a Try again that resets the boundary. */
export function Stopped(props: { title: string; error: unknown; onRetry: () => void; class: string }): JSX.Element {
  return (
    <div role="alert" class={`flex flex-col items-center justify-center gap-3 px-6 text-center ${props.class}`}>
      <span class="text-base text-ink-2">{props.title}</span>
      <span class="max-w-[420px] font-mono text-xs text-ink-3">{props.error instanceof Error ? props.error.message : String(props.error)}</span>
      <button
        type="button"
        onClick={() => props.onRetry()}
        class="rounded-sm border border-line-2 px-2.5 py-1 text-sm text-ink-2 hover:border-line-3 hover:bg-secondary"
      >
        Try again
      </button>
    </div>
  )
}
