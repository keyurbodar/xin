import "@ui-sdk/web/toolbar"
import { Check, Copy, Ellipsis, Reply } from "lucide-solid"
import { Show, createSignal, onCleanup, type JSX } from "solid-js"

/** Put on the message element: the toolbar shows while the pointer is over it or focus is inside it. */
export const MESSAGE_HOST = "group/message relative"

const ICON = { size: 14, "stroke-width": 1.5 } as const

const BUTTON =
  "im-press im-focus grid h-[var(--h-control-xs)] w-[var(--h-control-xs)] place-items-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"

/** The message's hover toolbar on UI SDK's Toolbar: one tab stop, arrow keys between reply, copy and more. */
export function MessageToolbar(props: {
  time: string
  dateTime: string
  onReply: () => void
  onCopy: () => void
  onMore: (button: HTMLButtonElement) => void
}): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = (): void => {
    props.onCopy()
    setCopied(true)
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div class="pointer-events-none absolute -top-3.5 right-2 z-10 flex h-8 items-center gap-1 rounded-md bg-popover pl-2.5 pr-1 opacity-0 shadow-[var(--shadow-popover)] group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100">
      <time datetime={props.dateTime} class="pr-1 text-mini text-ink-3">
        {props.time}
      </time>
      <ui-toolbar aria-label="Message actions" class="flex items-center gap-0.5">
        <ui-toolbar-button>
          <button type="button" aria-label="Reply" class={BUTTON} onClick={() => props.onReply()}>
            <Reply {...ICON} />
          </button>
        </ui-toolbar-button>
        <ui-toolbar-button>
          <button type="button" aria-label={copied() ? "Copied" : "Copy"} class={BUTTON} onClick={copy}>
            <Show when={copied()} fallback={<Copy {...ICON} />}>
              <Check {...ICON} class="text-done" />
            </Show>
          </button>
        </ui-toolbar-button>
        <ui-toolbar-button>
          <button
            type="button"
            aria-label="More"
            class={BUTTON}
            onClick={(event) => props.onMore(event.currentTarget)}
          >
            <Ellipsis {...ICON} />
          </button>
        </ui-toolbar-button>
      </ui-toolbar>
    </div>
  )
}
