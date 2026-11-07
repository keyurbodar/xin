import { For, Show, createSignal, type JSX } from "solid-js"
import { MAX_UPLOAD_BYTES, type UploadedFile } from "../../lib/api.ts"
import type { ModelInfo, ModelRef } from "../../state/settings.ts"
import { FileChip } from "../ui/file-chip.tsx"
import { Icon } from "../ui/icon.tsx"
import { Spinner } from "./ui.tsx"

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function useGrow(): {
  ref: (element: HTMLTextAreaElement) => void
  resize: () => void
} {
  let element: HTMLTextAreaElement | undefined
  const resize = (): void => {
    if (element === undefined) return
    element.style.height = "auto"
    const content = element.scrollHeight
    if (content === 0) return
    element.style.height = `${Math.min(content, 240)}px`
  }
  return {
    ref: (next) => {
      element = next
      queueMicrotask(resize)
    },
    resize,
  }
}

export type SendKey = { readonly id: string; readonly at: number }
export type Send = (text: string, key: SendKey, attachments: readonly UploadedFile[]) => Promise<void>

/** One key per draft and its files, so a retry after a lost ack replays the same command instead of adding a second message. */
function useSender(onSend: Send, blocked: () => boolean) {
  const [sending, setSending] = createSignal(false)
  let pending: { readonly fingerprint: string; readonly key: SendKey } | undefined
  const send = async (text: string, attachments: readonly UploadedFile[]): Promise<boolean> => {
    if (text === "" && attachments.length === 0) return false
    if (sending() || blocked()) return false
    const fingerprint = `${text}\u0000${attachments.map((file) => file.path).join(",")}`
    const key = pending?.fingerprint === fingerprint ? pending.key : { id: crypto.randomUUID(), at: Date.now() }
    pending = { fingerprint, key }
    setSending(true)
    try {
      await onSend(text, key, attachments)
      pending = undefined
      return true
    } finally {
      setSending(false)
    }
  }
  return { sending, send }
}

type PendingUpload = {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly size: number
  readonly progress: number
  readonly error?: string
}

function AttachmentChips(props: {
  files: readonly UploadedFile[]
  pending: readonly PendingUpload[]
  onRemoveFile: (path: string) => void
  onRemovePending: (id: string) => void
}): JSX.Element {
  return (
    <Show when={props.files.length > 0 || props.pending.length > 0}>
      <div class="flex flex-wrap gap-1.5 px-3 pt-2.5">
        <For each={props.files}>
          {(file) => (
            <FileChip
              name={file.name}
              type={file.type}
              size={file.size}
              onRemove={() => props.onRemoveFile(file.path)}
            />
          )}
        </For>
        <For each={props.pending}>
          {(item) => (
            <FileChip
              name={item.name}
              type={item.type}
              size={item.size}
              progress={item.progress}
              error={item.error}
              onRemove={() => props.onRemovePending(item.id)}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

export function Composer(props: {
  projectName: string
  modelLabel: string
  model: ModelRef | undefined
  models: readonly ModelInfo[]
  busy: boolean
  onPickModel: (model: ModelRef) => Promise<void>
  onSend: Send
  onStop: () => Promise<void>
  onAttach?: ((file: File, onProgress?: (fraction: number) => void) => Promise<UploadedFile>) | undefined
}): JSX.Element {
  const [draft, setDraft] = createSignal("")
  const { sending, send } = useSender(props.onSend, () => false)
  const [files, setFiles] = createSignal<readonly UploadedFile[]>([])
  const [pending, setPending] = createSignal<readonly PendingUpload[]>([])
  const uploading = (): boolean => pending().some((item) => item.error === undefined)
  let fileInput!: HTMLInputElement

  const amend = (id: string, patch: Partial<PendingUpload>): void => {
    setPending((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const attach = async (picked: FileList | null): Promise<void> => {
    const upload = props.onAttach
    if (picked === null || upload === undefined) return
    setError(undefined)
    const chosen = Array.from(picked)
    const added = chosen.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type === "" ? "application/octet-stream" : file.type,
      size: file.size,
      progress: 0,
    }))
    setPending((current) => [...current, ...added])
    fileInput.value = ""
    await Promise.all(
      chosen.map(async (file, index) => {
        const item = added[index]
        if (item === undefined) return
        if (file.size > MAX_UPLOAD_BYTES) {
          amend(item.id, { error: "Too big · 50 MB max" })
          return
        }
        try {
          const uploaded = await upload(file, (fraction) => amend(item.id, { progress: fraction }))
          setPending((current) => current.filter((entry) => entry.id !== item.id))
          setFiles((current) => [...current, uploaded])
        } catch (failure) {
          amend(item.id, { error: errorText(failure) })
        }
      }),
    )
  }
  const [stopping, setStopping] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const [failedStop, setFailedStop] = createSignal(false)
  const [picker, setPicker] = createSignal(false)
  const grow = useGrow()

  const empty = (): boolean => draft().trim() === "" && files().length === 0
  const submit = async (): Promise<void> => {
    if (uploading()) return
    setError(undefined)
    try {
      const text = draft().trim()
      if (await send(text, files())) {
        setDraft("")
        setFiles([])
        grow.resize()
      }
    } catch (failure) {
      setFailedStop(false)
      setError(errorText(failure))
    }
  }

  const stop = async (): Promise<void> => {
    if (stopping()) return
    setStopping(true)
    setError(undefined)
    try {
      await props.onStop()
    } catch (failure) {
      setFailedStop(true)
      setError(errorText(failure))
    } finally {
      setStopping(false)
    }
  }

  return (
    <div class="shrink-0 px-6 pb-4 pt-3">
      <div class="mx-auto w-full max-w-[760px]">
        <div class="overflow-hidden rounded-[4px] border border-line-inner bg-raised focus-within:border-line-strong focus-within:shadow-[0_0_0_1px_#060505,0_0_0_3px_rgba(255,90,0,0.35)]">
          <textarea
            ref={grow.ref}
            value={draft()}
            rows={1}
            disabled={sending()}
            onInput={(event) => {
              setDraft(event.currentTarget.value)
              grow.resize()
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={`Message ${props.projectName}…`}
            class="block max-h-[240px] min-h-[24px] w-full resize-none bg-transparent px-3.5 pb-1.5 pt-3 text-[14px] leading-[1.6] text-fg outline-none placeholder:text-fg-4 disabled:opacity-60"
          />
          <AttachmentChips
            files={files()}
            pending={pending()}
            onRemoveFile={(path) => setFiles((current) => current.filter((file) => file.path !== path))}
            onRemovePending={(id) => setPending((current) => current.filter((item) => item.id !== id))}
          />
          <div class="flex items-center gap-1 px-2 pb-2 pt-1.5">
            <Show
              when={props.onAttach}
              fallback={
                <button
                  type="button"
                  title="Attachments need a project"
                  aria-disabled="true"
                  class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-4"
                >
                  <Icon name="paperclip" size={14} />
                </button>
              }
            >
              <button
                type="button"
                onClick={() => fileInput.click()}
                disabled={uploading()}
                title="Attach a file"
                aria-label="Attach a file"
                class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-50"
              >
                <Show when={uploading()} fallback={<Icon name="paperclip" size={14} />}>
                  <Spinner class="border-fg-4/40 border-t-fg-2" />
                </Show>
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                class="hidden"
                onChange={(event) => void attach(event.currentTarget.files)}
              />
            </Show>
            <div class="relative">
              <button
                type="button"
                onClick={() => setPicker((open) => !open)}
                aria-expanded={picker()}
                aria-haspopup="listbox"
                class="flex h-7 items-center gap-1.5 rounded-[2px] px-2 text-[12.5px] font-medium text-fg-2 hover:bg-hover hover:text-fg"
              >
                <span class="max-w-[220px] truncate">{props.modelLabel}</span>
                <Icon name="chevron-down" size={12} class="text-fg-4" />
              </button>
              <Show when={picker()}>
                <div
                  role="listbox"
                  aria-label="Model"
                  class="enter absolute bottom-9 left-0 z-30 max-h-[320px] w-[300px] overflow-y-auto rounded-[4px] border border-line-inner bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
                >
                  <Show
                    when={props.models.length > 0}
                    fallback={<div class="px-2.5 py-2 text-[12px] text-fg-3">No models yet. Add a provider key in Settings.</div>}
                  >
                    <For each={props.models}>
                      {(model) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={props.model?.modelId === model.modelId && props.model?.provider === model.provider}
                          onClick={() => {
                            setPicker(false)
                            void props.onPickModel({ provider: model.provider, modelId: model.modelId })
                          }}
                          class="flex w-full items-center gap-2 rounded-[2px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover"
                        >
                          <span class="min-w-0 flex-1 truncate">{model.name}</span>
                          <span class="mono-meta shrink-0">{model.provider}</span>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>
            </div>
            <Show when={props.busy}>
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopping()}
                aria-label="Stop the run"
                class="ml-auto grid h-8 w-8 place-items-center rounded-[2px] bg-fg text-page hover:opacity-90 disabled:opacity-60"
              >
                <Icon name="stop" size={12} />
              </button>
            </Show>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending() || empty()}
              aria-label="Send message"
              class="grid h-8 w-8 place-items-center rounded-[2px]"
              classList={{
                "ml-auto": !props.busy,
                "bg-accent text-ink hover:opacity-90": !empty() && !sending(),
                "bg-hover text-fg-4": empty() || sending(),
              }}
            >
              <Show when={sending()} fallback={<Icon name="arrow-up" size={16} />}>
                <Spinner class="border-ink/30 border-t-ink" />
              </Show>
            </button>
          </div>
        </div>
        <Show when={error()}>
          {(message) => (
            <div class="mt-2 flex items-center gap-2 rounded-[2px] border border-failed/40 bg-bad-bg px-3 py-2 text-[12px] text-bad">
              <Icon name="x" size={12} />
              <span class="min-w-0 flex-1 truncate">{message()}</span>
              <button
                type="button"
                class="link"
                onClick={() => void (failedStop() ? stop() : submit())}
              >
                Retry
              </button>
            </div>
          )}
        </Show>
        <div class="mt-2 flex items-center gap-2 text-[11.5px] text-fg-4">
          <span class="kbd">↵</span>
          <span>send</span>
          <span class="kbd">⇧</span>
          <span class="kbd">↵</span>
          <span>new line</span>
          <Show when={props.busy}>
            <span class="ml-auto font-mono text-[10.5px] text-fg-3">The run is live · Stop ends it</span>
          </Show>
        </div>
      </div>
    </div>
  )
}

export function SteerComposer(props: {
  threadTitle: string
  busy: boolean
  waiting: boolean
  onSend: Send
  onStop: () => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = createSignal("")
  const { sending, send } = useSender(props.onSend, () => props.waiting)
  const [stopping, setStopping] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  const grow = useGrow()

  const submit = async (): Promise<void> => {
    setError(undefined)
    try {
      if (await send(draft().trim(), [])) {
        setDraft("")
        grow.resize()
      }
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  const stop = async (): Promise<void> => {
    if (stopping()) return
    setStopping(true)
    setError(undefined)
    try {
      await props.onStop()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setStopping(false)
    }
  }

  return (
    <div class="shrink-0 border-t border-line p-3">
      <div class="overflow-hidden rounded-[4px] border border-line-inner bg-raised focus-within:border-line-strong">
        <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[11.5px] text-fg-3">
          <Show
            when={props.busy}
            fallback={
              <span classList={{ "text-accent-text": props.waiting }}>
                {props.waiting ? "Waiting on you" : "Finished"}
              </span>
            }
          >
            <span class="shimmer">Working</span>
          </Show>
          <span class="truncate font-mono text-[10.5px] text-fg-4">{props.threadTitle}</span>
        </div>
        <textarea
          ref={grow.ref}
          value={draft()}
          rows={1}
          disabled={sending() || props.waiting}
          onInput={(event) => {
            setDraft(event.currentTarget.value)
            grow.resize()
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={
            props.waiting
              ? "Answer the question above first"
              : props.busy
                ? "Steer this thread…"
                : "Ask a follow-up, or re-run with changes…"
          }
          class="block max-h-[180px] min-h-[22px] w-full resize-none bg-transparent px-3 pb-1.5 pt-2.5 text-[13px] leading-[1.6] text-fg outline-none placeholder:text-fg-4 disabled:opacity-60"
        />
        <div class="flex items-center gap-1 px-1.5 pb-1.5">
          <button
            type="button"
            title="Attachments are not wired yet"
            aria-disabled="true"
            class="grid h-6 w-6 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg"
          >
            <Icon name="paperclip" size={13} />
          </button>
          <Show when={props.busy}>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping()}
              aria-label="Stop this thread"
              class="ml-auto grid h-7 w-7 place-items-center rounded-[2px] bg-fg text-page disabled:opacity-60"
            >
              <Icon name="stop" size={11} />
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending() || props.waiting || draft().trim() === ""}
            aria-label="Send to thread"
            class="grid h-7 w-7 place-items-center rounded-[2px]"
            classList={{
              "ml-auto": !props.busy,
              "bg-accent text-ink": draft().trim() !== "" && !props.waiting,
              "bg-hover text-fg-4": draft().trim() === "" || props.waiting,
            }}
          >
            <Show when={sending()} fallback={<Icon name="arrow-up" size={14} />}>
              <Spinner class="border-ink/30 border-t-ink" />
            </Show>
          </button>
        </div>
      </div>
      <Show when={error()}>
        {(message) => <div class="mt-2 text-[12px] text-bad">{message()}</div>}
      </Show>
    </div>
  )
}
