import { File as FileIcon, X } from "lucide-solid"
import { For, Show, createSignal, onCleanup, type JSX } from "solid-js"
import { MAX_UPLOAD_BYTES, OpError, type UploadedFile } from "../../lib/api.ts"
import { bytes } from "../../lib/format.ts"

export type Upload = (file: File, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<UploadedFile>

type AttachmentState =
  | { readonly kind: "uploading"; readonly progress: number }
  | { readonly kind: "done"; readonly uploaded: UploadedFile }
  | { readonly kind: "failed"; readonly error: string }

type Attachment = {
  readonly id: string
  readonly file: File
  readonly preview: string | undefined
  readonly controller: AbortController
  readonly state: AttachmentState
}

function failureText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Every file the composer holds, each with its own XHR, so removing one aborts only that upload. */
export function useAttachments(upload: () => Upload) {
  const [items, setItems] = createSignal<readonly Attachment[]>([])

  const patch = (id: string, state: AttachmentState): void => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, state } : item)))
  }

  const add = (files: readonly File[]): void => {
    const added: readonly Attachment[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      controller: new AbortController(),
      state: { kind: "uploading", progress: 0 },
    }))
    setItems((current) => [...current, ...added])
    for (const item of added) {
      if (item.file.size > MAX_UPLOAD_BYTES) {
        patch(item.id, { kind: "failed", error: "Too big · 50 MB max" })
        continue
      }
      upload()(item.file, (progress) => patch(item.id, { kind: "uploading", progress }), item.controller.signal)
        .then((uploaded) => patch(item.id, { kind: "done", uploaded }))
        .catch((failure: unknown) => {
          if (failure instanceof OpError && failure.code === "aborted") return
          patch(item.id, { kind: "failed", error: failureText(failure) })
        })
    }
  }

  const release = (item: Attachment): void => {
    item.controller.abort()
    if (item.preview !== undefined) URL.revokeObjectURL(item.preview)
  }

  const remove = (id: string): void => {
    const found = items().find((item) => item.id === id)
    if (found !== undefined) release(found)
    setItems((current) => current.filter((item) => item.id !== id))
  }

  const clear = (): void => {
    for (const item of items()) release(item)
    setItems([])
  }

  onCleanup(clear)

  return {
    items,
    add,
    remove,
    clear,
    uploading: (): boolean => items().some((item) => item.state.kind === "uploading"),
    uploaded: (): readonly UploadedFile[] =>
      items().flatMap((item) => (item.state.kind === "done" ? [item.state.uploaded] : [])),
  }
}

function kindOf(file: File): string {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(file.name)?.[1]
  if (extension !== undefined) return extension.toUpperCase()
  const subtype = file.type.split("/")[1]
  return subtype === undefined || subtype === "" ? "File" : subtype.toUpperCase()
}

function statusOf(item: Attachment): string {
  const state = item.state
  switch (state.kind) {
    case "done":
      return kindOf(item.file)
    case "failed":
      return state.error
    case "uploading":
      if (state.progress <= 0) return "Preparing"
      if (state.progress >= 1) return "Finishing"
      return `${Math.round(state.progress * 100)}%`
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function AttachmentChip(props: { item: Attachment; onRemove: () => void }): JSX.Element {
  const failed = (): boolean => props.item.state.kind === "failed"
  const progress = (): number | undefined =>
    props.item.state.kind === "uploading" ? props.item.state.progress : undefined
  return (
    <div
      class="relative flex h-14 min-w-0 items-center gap-3 overflow-hidden rounded-md bg-secondary py-2 pl-2 pr-1.5 shadow-ring"
      classList={{ "shadow-[0_0_0_0.5px_var(--color-failed)]": failed() }}
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

export function AttachmentGrid(props: { items: readonly Attachment[]; onRemove: (id: string) => void }): JSX.Element {
  return (
    <Show when={props.items.length > 0}>
      <div class="grid max-w-[680px] grid-cols-1 gap-2 px-3 pb-1 pt-1 min-[560px]:grid-cols-2">
        <For each={props.items}>{(item) => <AttachmentChip item={item} onRemove={() => props.onRemove(item.id)} />}</For>
      </div>
    </Show>
  )
}
