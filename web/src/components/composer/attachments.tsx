import { File as FileIcon, X } from "lucide-solid"
import { For, Show, createEffect, createSignal, type JSX } from "solid-js"
import { createAttachments, kindLabel, statusLabel, type ComposerAttachment, type Upload } from "../../lib/attachments.ts"
import { bytes } from "../../lib/format.ts"
import { createPresence } from "../shell/presence.ts"

const CHIP_EXIT_MS = 140

export type { Upload }

type Attachment = ComposerAttachment

export const useAttachments = createAttachments

function statusOf(item: Attachment): string {
  return statusLabel(item.state) ?? kindLabel(item.file.name, item.file.type)
}

function AttachmentChip(props: { item: Attachment; leaving: boolean; onRemove: () => void }): JSX.Element {
  const failed = (): boolean => props.item.state.kind === "failed"
  const progress = (): number | undefined =>
    props.item.state.kind === "uploading" ? props.item.state.progress : undefined
  return (
    <div
      class="im-arrive composer-chip relative flex h-14 min-w-0 items-center gap-3 overflow-hidden rounded-md bg-secondary py-2 pl-2 pr-1.5 shadow-ring"
      classList={{ "shadow-[0_0_0_0.5px_var(--color-failed)]": failed() }}
      data-closing={props.leaving ? "" : undefined}
      inert={props.leaving}
    >
      <span class="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted text-icon">
        <Show
          when={props.item.state.kind === "done" ? props.item.preview : undefined}
          fallback={<FileIcon size={16} stroke-width={1.5} />}
        >
          {(source) => <img src={source()} alt="" class="h-full w-full object-cover" />}
        </Show>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-ink">{props.item.file.name}</span>
        <span class="block truncate text-xs tabular-nums" classList={{ "text-failed": failed(), "text-ink-3": !failed() }}>
          {bytes(props.item.file.size)} · {statusOf(props.item)}
        </span>
      </span>
      <button
        type="button"
        onClick={() => props.onRemove()}
        aria-label={`Remove ${props.item.file.name}`}
        class="composer-press grid h-6 w-6 shrink-0 place-items-center rounded-sm text-icon hover:bg-hover hover:text-ink"
      >
        <X size={14} stroke-width={1.5} />
      </button>
      <Show when={progress()}>
        {(fraction) => (
          <span
            class="composer-bar absolute bottom-0 left-0 h-[2px] w-full bg-primary"
            style={{ transform: `scaleX(${fraction()})` }}
          />
        )}
      </Show>
    </div>
  )
}

function PresentChip(props: { item: Attachment; live: boolean; onRemove: () => void; onGone: () => void }): JSX.Element {
  const presence = createPresence(() => props.live, CHIP_EXIT_MS)
  createEffect(() => {
    if (!presence.mounted()) props.onGone()
  })
  return (
    <Show when={presence.mounted()}>
      <AttachmentChip item={props.item} leaving={presence.leaving()} onRemove={props.onRemove} />
    </Show>
  )
}

/** Chips are keyed by id so an upload's progress never remounts one, and a removed chip stays through its exit. */
export function AttachmentGrid(props: { items: readonly Attachment[]; onRemove: (id: string) => void }): JSX.Element {
  const seen = new Map<string, Attachment>()
  const [shown, setShown] = createSignal<readonly string[]>([])
  createEffect(() => {
    const live = props.items
    for (const item of live) seen.set(item.id, item)
    setShown((current) => [...current, ...live.flatMap((item) => (current.includes(item.id) ? [] : [item.id]))])
  })
  const itemOf = (id: string): Attachment | undefined => props.items.find((item) => item.id === id) ?? seen.get(id)
  const gone = (id: string): void => {
    seen.delete(id)
    setShown((current) => current.filter((entry) => entry !== id))
  }
  return (
    <Show when={shown().length > 0}>
      <div class="grid max-w-[680px] grid-cols-1 gap-2 px-3 pb-1 pt-1 min-[560px]:grid-cols-2">
        <For each={shown()}>
          {(id) => (
            <Show when={itemOf(id)}>
              {(item) => (
                <PresentChip
                  item={item()}
                  live={props.items.some((entry) => entry.id === id)}
                  onRemove={() => props.onRemove(id)}
                  onGone={() => gone(id)}
                />
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}
