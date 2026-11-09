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
      class="relative inline-flex h-[26px] max-w-[240px] items-center gap-1.5 overflow-hidden rounded-[2px] border py-1 pl-2 text-[12px]"
      classList={{
        "border-bad/60 pr-1 text-bad": failed(),
        "border-line-inner pr-1 text-fg-2": !failed() && props.onRemove !== undefined,
        "border-line-inner pr-2 text-fg-2": !failed() && props.onRemove === undefined,
      }}
    >
      <Icon
        name={props.type.startsWith("image/") ? "image" : "file"}
        size={12}
        class={failed() ? "shrink-0 text-bad" : "shrink-0 text-fg-3"}
      />
      <span class="min-w-0 truncate">{props.name}</span>
      <Show
        when={props.error}
        fallback={
          <Show when={props.size}>
            {(size) => <span class="shrink-0 text-[11px] text-fg-4">{bytes(size())}</span>}
          </Show>
        }
      >
        {(error) => <span class="shrink-0 text-[11px]">{error()}</span>}
      </Show>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            onClick={remove()}
            aria-label={`Remove ${props.name}`}
            class="grid h-4 w-4 shrink-0 place-items-center rounded-[2px] text-fg-4 hover:bg-selected hover:text-fg"
          >
            <Icon name="x" size={10} />
          </button>
        )}
      </Show>
      <Show when={props.progress !== undefined && props.progress < 1}>
        <span
          class="absolute bottom-0 left-0 h-[1.5px] bg-accent"
          style={{ width: `${Math.round((props.progress ?? 0) * 100)}%` }}
        />
      </Show>
    </span>
  )
}
