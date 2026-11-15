import { createSignal, type Accessor, type JSX } from "solid-js"
import { Button as SharedButton } from "../ui/button.tsx"

export { EmptyState } from "../ui/state.tsx"
export { Spinner } from "../ui/loaders.tsx"

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

export function ResourceError(props: { what: string; error: unknown; onRetry: () => void }): JSX.Element {
  return (
    <div class="flex flex-col gap-2 border-b border-line-1 px-3 py-4">
      <span class="text-sm text-ink-2">Couldn’t load {props.what}.</span>
      <span class="font-mono text-2xs text-failed">{errorMessage(props.error)}</span>
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
