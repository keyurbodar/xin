import { Show, type JSX } from "solid-js"
import { Icon } from "./icon.tsx"

/** One attachment, as the composer and the transcript both show it. */
export function FileChip(props: {
  name: string
  type: string
  onRemove?: (() => void) | undefined
}): JSX.Element {
  return (
    <span
      class="inline-flex max-w-[240px] items-center gap-1.5 rounded-[2px] border border-line-inner py-1 pl-2 text-[12px] text-fg-2"
      classList={{ "bg-hover pr-1": props.onRemove !== undefined, "bg-raised pr-2": props.onRemove === undefined }}
    >
      <Icon name={props.type.startsWith("image/") ? "image" : "file"} size={12} class="shrink-0 text-fg-3" />
      <span class="min-w-0 truncate">{props.name}</span>
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
    </span>
  )
}
