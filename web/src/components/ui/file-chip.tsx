import { Show, type JSX } from "solid-js"
import { bytes } from "../../lib/format.ts"
import { Icon } from "./icon.tsx"

/** One attachment, as the composer and the transcript both show it (D8, C15). */
export function FileChip(props: {
  name: string
  type: string
  size?: number | undefined
  progress?: number | undefined
  error?: string | undefined
  onRemove?: (() => void) | undefined
}): JSX.Element {
  const failed = (): boolean => props.error !== undefined
  return (
    <span
      class="relative inline-flex h-[26px] max-w-[240px] items-center gap-1.5 overflow-hidden rounded-sm border py-1 pl-2 text-sm"
      classList={{
        "border-failed/60 pr-1 text-failed": failed(),
        "border-line-2 pr-1 text-ink-2": !failed() && props.onRemove !== undefined,
        "border-line-2 pr-2 text-ink-2": !failed() && props.onRemove === undefined,
      }}
    >
      <Icon
        name={props.type.startsWith("image/") ? "image" : "file"}
        size={12}
        class={failed() ? "shrink-0 text-failed" : "shrink-0 text-ink-3"}
      />
      <span class="min-w-0 truncate">{props.name}</span>
      <Show
        when={props.error}
        fallback={
          <Show when={props.size}>
            {(size) => <span class="shrink-0 text-2xs text-icon">{bytes(size())}</span>}
          </Show>
        }
      >
        {(error) => <span class="shrink-0 text-2xs">{error()}</span>}
      </Show>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            onClick={remove()}
            aria-label={`Remove ${props.name}`}
            class="grid h-4 w-4 shrink-0 place-items-center rounded-sm text-icon hover:bg-hover hover:text-ink"
          >
            <Icon name="x" size={10} />
          </button>
        )}
      </Show>
      <Show when={props.progress !== undefined && props.progress < 1}>
        <span
          class="absolute bottom-0 left-0 h-[1.5px] bg-primary"
          style={{ width: `${Math.round((props.progress ?? 0) * 100)}%` }}
        />
      </Show>
    </span>
  )
}
