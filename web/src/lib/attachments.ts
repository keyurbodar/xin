import { createSignal, onCleanup } from "solid-js"
import { token } from "./auth.ts"
import { MAX_UPLOAD_BYTES, OpError, uploadFile, type UploadedFile } from "./api.ts"

/** The most files one message carries, as `message.send` allows. */
export const MAX_ATTACHMENTS = 12

/** What `message.send` takes for each file: the path it was stored at, with the name, type and size the browser saw. */
export type AttachmentPayload = UploadedFile

export type Upload = (file: File, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<AttachmentPayload>

export type AttachmentState =
  | { readonly kind: "uploading"; readonly progress: number }
  | { readonly kind: "done"; readonly uploaded: AttachmentPayload }
  | { readonly kind: "failed"; readonly error: string }

export type ComposerAttachment = {
  readonly id: string
  readonly file: File
  readonly preview: string | undefined
  readonly controller: AbortController
  readonly state: AttachmentState
}

/** A sent message's file as the transcript records it; `sha256` is the content address its bytes are read back by. */
export type SentAttachment = {
  readonly name: string
  readonly type: string
  readonly size?: number | undefined
  readonly sha256?: string | undefined
}

const THUMBNAIL = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/u

export const hasThumbnail = (type: string): boolean => THUMBNAIL.test(type)

/** Why a file cannot be attached next to `held` others, or undefined when it can. */
export function rejectionOf(file: File, held: number): string | undefined {
  if (held >= MAX_ATTACHMENTS) return `${MAX_ATTACHMENTS} files per message`
  if (file.size === 0) return "Empty file"
  if (file.size > MAX_UPLOAD_BYTES) return `Too big · ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB max`
  return undefined
}

/** "215 KB", "1.3 MB": whole kilobytes, one decimal from a megabyte up. */
export function sizeLabel(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`
  return `${(count / (1024 * 1024)).toFixed(1)} MB`
}

/** The kind a card names: the extension when the name has one, else the MIME subtype. */
export function kindLabel(name: string, type: string): string {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(name)?.[1]
  if (extension !== undefined) return extension.toUpperCase()
  const subtype = type.split("/")[1]?.split("+")[0]
  return subtype === undefined || subtype === "" ? "File" : subtype.toUpperCase()
}

export function statusLabel(state: AttachmentState): string | undefined {
  switch (state.kind) {
    case "done":
      return undefined
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

/** Uploads into a folder of the files tree, each under a fresh name so two files called the same never collide. */
export const uploadInto =
  (folder: string): Upload =>
  (file, onProgress, signal) =>
    uploadFile(file, folder, onProgress, signal)

function failureText(file: File, failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.startsWith(`${file.name}: `) ? message.slice(file.name.length + 2) : message
}

/** Every file the composer holds, each with its own request, so removing one aborts only that upload. */
export function createAttachments(upload: () => Upload) {
  const [items, setItems] = createSignal<readonly ComposerAttachment[]>([])

  const patch = (id: string, state: AttachmentState): void => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, state } : item)))
  }

  const add = (files: readonly File[]): void => {
    const held = items().length
    const added = files.map((file, index) => ({
      item: {
        id: crypto.randomUUID(),
        file,
        preview: hasThumbnail(file.type) ? URL.createObjectURL(file) : undefined,
        controller: new AbortController(),
        state: { kind: "uploading", progress: 0 },
      } satisfies ComposerAttachment,
      rejection: rejectionOf(file, held + index),
    }))
    setItems((current) => [...current, ...added.map(({ item }) => item)])
    for (const { item, rejection } of added) {
      if (rejection !== undefined) {
        patch(item.id, { kind: "failed", error: rejection })
        continue
      }
      upload()(item.file, (progress) => patch(item.id, { kind: "uploading", progress }), item.controller.signal)
        .then((uploaded) => patch(item.id, { kind: "done", uploaded }))
        .catch((failure: unknown) => {
          if (failure instanceof OpError && failure.code === "aborted") return
          patch(item.id, { kind: "failed", error: failureText(item.file, failure) })
        })
    }
  }

  const release = (item: ComposerAttachment): void => {
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
    uploaded: (): readonly AttachmentPayload[] =>
      items().flatMap((item) => (item.state.kind === "done" ? [item.state.uploaded] : [])),
  }
}

const blobUrls = new Map<string, Promise<string>>()

/**
 * An object URL for a stored blob, fetched once per page: blobs are content-addressed, so a URL never goes stale.
 * Rejects when the blob is gone, so the caller can show the file without a thumbnail.
 */
export function blobUrl(sha256: string, type: string): Promise<string> {
  const known = blobUrls.get(sha256)
  if (known !== undefined) return known
  const loading = fetch(`/blobs/${sha256}`, { headers: { authorization: `Bearer ${token()}` } }).then(async (response) => {
    if (!response.ok) throw new OpError("http", `blob ${sha256.slice(0, 8)}: HTTP ${response.status}`)
    return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }))
  })
  loading.catch(() => blobUrls.delete(sha256))
  blobUrls.set(sha256, loading)
  return loading
}
