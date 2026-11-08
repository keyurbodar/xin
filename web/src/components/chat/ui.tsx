import { createSignal, type Accessor, type JSX } from "solid-js"
import { Button as SharedButton } from "../ui/button.tsx"

export { EmptyState } from "../ui/state.tsx"

export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

export function ResourceError(props: { what: string; error: unknown; onRetry: () => void }): JSX.Element {
  return (
    <div class="flex flex-col gap-2 border-b border-line px-3 py-4">
      <span class="text-[13px] text-fg-2">Couldn’t load {props.what}.</span>
      <span class="font-mono text-[11px] text-bad">{errorMessage(props.error)}</span>
      <button type="button" class="link self-start" onClick={() => props.onRetry()}>
        Retry
      </button>
    </div>
  )
}

/** One pane action at a time: a row key while its command runs, and the failure text after it. */
export function createPaneAction(): {
  readonly busy: Accessor<string | number | undefined>
  readonly failed: Accessor<string | undefined>
  readonly run: (key: string | number, work: () => Promise<void>) => Promise<void>
} {
  const [busy, setBusy] = createSignal<string | number | undefined>()
  const [failed, setFailed] = createSignal<string | undefined>()
  const run = async (key: string | number, work: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setFailed(undefined)
    try {
      await work()
    } catch (problem) {
      setFailed(errorMessage(problem))
    } finally {
      setBusy(undefined)
    }
  }
  return { busy, failed, run }
}

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

/** I1: the small loader. A faint ring with a quarter arc, one turn every 0.8s, in the current colour. */
export function Spinner(props: { size?: number; class?: string }): JSX.Element {
  const size = (): number => props.size ?? 16
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      role="img"
      aria-label="Working"
      class={props.class}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.6" />
      <g class="spinner-arc">
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </g>
    </svg>
  )
}

/** Ghost rows for a panel list: the same row height and gutters as the real rows, so nothing shifts when data lands. */
export function PanelGhost(props: { rows: number }): JSX.Element {
  return (
    <div class="flex flex-col">
      {Array.from({ length: props.rows }, (_, index) => (
        <div class="flex h-11 items-center gap-2.5 border-b border-line px-3">
          <span class="h-4 w-4 shrink-0 rounded-[8px] border border-line-inner bg-raised" />
          <span class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="h-2.5 rounded-[4px] bg-hover" style={{ width: `${54 + (index % 3) * 12}%` }} />
            <span class="h-2 rounded-[4px] bg-hover" style={{ width: `${28 + (index % 4) * 8}%` }} />
          </span>
          <span class="h-2 w-6 rounded-[4px] bg-hover" />
        </div>
      ))}
    </div>
  )
}
