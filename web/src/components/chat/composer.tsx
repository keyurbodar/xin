import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { takePendingDraft } from "../../lib/draft.ts"
import { MAX_UPLOAD_BYTES, type UploadedFile } from "../../lib/api.ts"
import { THINKING_LEVELS, type ThinkingLevel } from "../../state/conversation.ts"
import type { PresetRow } from "../../state/extensions.ts"
import { type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { FileChip } from "../ui/file-chip.tsx"
import { GlideList, MenuItem, MenuSurface } from "../ui/glide.tsx"
import { Icon } from "../ui/icon.tsx"
import { ModelPicker } from "./model-picker.tsx"
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

const TOOL_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-50"
const ROUND_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-fill-strong hover:text-fg disabled:opacity-50"

const EFFORT_WORD: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
}

/** V3: the three bars fill up with the level, the way the frame draws effort. */
function EffortBars(props: { level: ThinkingLevel | undefined }): JSX.Element {
  const lit = (): number => (props.level === undefined ? 0 : THINKING_LEVELS.indexOf(props.level))
  return (
    <span class="flex items-end gap-[1.5px]" aria-hidden="true">
      <For each={[4, 6, 8]}>
        {(height, index) => (
          <span
            class="w-[2px] rounded-[0.5px]"
            style={{
              height: `${height}px`,
              background: index() < lit() ? "var(--color-fg-2)" : "var(--color-line-strong)",
            }}
          />
        )}
      </For>
    </span>
  )
}

function ChoiceRow(props: {
  label: string
  detail?: string | undefined
  checked: boolean
  disabled?: boolean | undefined
  onPick: () => void
  value?: string | undefined
}): JSX.Element {
  return (
    <MenuItem value={props.value} selected={props.checked} check disabled={props.disabled === true} onClick={props.onPick}>
      <span class="min-w-0 flex-1">
        <span class="block truncate">{props.label}</span>
        <Show when={props.detail}>
          {(text) => <span class="block truncate text-[11.5px] text-fg-3">{text()}</span>}
        </Show>
      </span>
      <Show when={props.checked}>
        <Icon name="check" size={12} class="shrink-0 text-fg-3" />
      </Show>
    </MenuItem>
  )
}

export function Composer(props: {
  projectName: string
  modelLabel: string
  model: ModelRef | undefined
  models: readonly ModelInfo[]
  omitted: number
  query: string
  busy: boolean
  presets: readonly PresetRow[]
  presetId: string | undefined
  presetLocked: boolean
  effort: ThinkingLevel | undefined
  reasoning: boolean
  onPickModel: (model: ModelRef) => Promise<void>
  onPickPreset: (id: string) => Promise<void>
  onPickEffort: (level: ThinkingLevel) => Promise<void>
  onSearch: (query: string) => void
  onSend: Send
  onStop: () => Promise<void>
  onAttach: (file: File, onProgress?: (fraction: number) => void) => Promise<UploadedFile>
}): JSX.Element {
  const [draft, setDraft] = createSignal(takePendingDraft() ?? "")
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
  const [toolError, setToolError] = createSignal<string | undefined>()
  const [failedStop, setFailedStop] = createSignal(false)
  const [menu, setMenu] = createSignal<"preset" | "model" | "effort">()
  const grow = useGrow()
  let bar!: HTMLDivElement

  const toggleMenu = (next: "preset" | "model" | "effort"): void => {
    setMenu((current) => (current === next ? undefined : next))
    setToolError(undefined)
    if (next === "model") props.onSearch("")
  }

  onMount(() => {
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && !bar.contains(event.target)) setMenu(undefined)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && menu() !== undefined) {
        event.stopPropagation()
        setMenu(undefined)
      }
    }
    document.addEventListener("pointerdown", away)
    document.addEventListener("keydown", escape)
    onCleanup(() => {
      document.removeEventListener("pointerdown", away)
      document.removeEventListener("keydown", escape)
    })
  })

  const choose = async (work: () => Promise<void>): Promise<void> => {
    setMenu(undefined)
    setToolError(undefined)
    try {
      await work()
    } catch (failure) {
      setToolError(errorText(failure))
    }
  }

  const presetLabel = (): string => {
    const found = props.presets.find((preset) => preset.id === props.presetId)
    return found?.name ?? props.presetId ?? "Preset"
  }
  const effortWord = (): string => (props.effort === undefined ? "Default" : EFFORT_WORD[props.effort])

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
    <div class="shrink-0 px-6 pb-5 pt-3">
      <div class="mx-auto w-full max-w-[820px]">
        <div class="rounded-[12px] bg-raised shadow-[inset_0_0_0_1px_var(--color-line)] transition-[box-shadow] duration-[160ms] ease-[var(--ease-kiko)] focus-within:shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
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
            class="block max-h-[240px] min-h-[24px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-[24px] text-fg outline-none placeholder:text-fg-4 disabled:opacity-60"
          />
          <AttachmentChips
            files={files()}
            pending={pending()}
            onRemoveFile={(path) => setFiles((current) => current.filter((file) => file.path !== path))}
            onRemovePending={(id) => setPending((current) => current.filter((item) => item.id !== id))}
          />
          <Show when={toolError()}>
            {(message) => <div class="px-4 pb-1.5 text-[12.5px] text-bad">{message()}</div>}
          </Show>
          <div ref={bar} class="flex items-center gap-0.5 px-2 pb-2 pt-0.5">
            <button
              type="button"
              onClick={() => fileInput.click()}
              disabled={uploading()}
              title="Attach a file"
              aria-label="Attach a file"
              class={ROUND_BUTTON}
            >
              <Show when={uploading()} fallback={<Icon name="paperclip" size={14} />}>
                <Spinner class="text-fg-3" />
              </Show>
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              class="hidden"
              onChange={(event) => void attach(event.currentTarget.files)}
            />
            <Show when={props.presets.length > 0}>
              <div class="relative">
                <button
                  type="button"
                  onClick={() => toggleMenu("preset")}
                  aria-expanded={menu() === "preset"}
                  aria-haspopup="menu"
                  class={TOOL_BUTTON}
                >
                  <span class="max-w-[120px] truncate">{presetLabel()}</span>
                  <Icon name="chevron-down" size={11} class="text-fg-4" />
                </button>
                <Show when={menu() === "preset"}>
                  <MenuSurface class="absolute bottom-10 left-0 w-[280px]">
                    <Show when={props.presetLocked}>
                      <div class="px-2 py-1.5 text-[11.5px] leading-snug text-fg-4">
                        This conversation has started, so its preset is fixed.
                      </div>
                    </Show>
                    <GlideList active={props.presetId} radius="4px">
                      <For each={props.presets}>
                        {(preset) => (
                          <ChoiceRow
                            value={preset.id}
                            label={preset.name}
                            detail={preset.description}
                            checked={preset.id === props.presetId}
                            disabled={props.presetLocked}
                            onPick={() => void choose(() => props.onPickPreset(preset.id))}
                          />
                        )}
                      </For>
                    </GlideList>
                  </MenuSurface>
                </Show>
              </div>
            </Show>
            <div class="relative">
              <button
                type="button"
                onClick={() => toggleMenu("model")}
                aria-expanded={menu() === "model"}
                aria-haspopup="dialog"
                class={TOOL_BUTTON}
              >
                <span class="max-w-[220px] truncate">{props.modelLabel}</span>
                <Icon name="chevron-down" size={11} class="text-fg-4" />
              </button>
              <Show when={menu() === "model"}>
                <div class="menu-in float absolute bottom-11 left-0 z-30 overflow-hidden">
                  <ModelPicker
                    models={props.models}
                    current={props.model}
                    omitted={props.omitted}
                    query={props.query}
                    onSearch={props.onSearch}
                    onPick={(picked) =>
                      void choose(() => props.onPickModel({ provider: picked.provider, modelId: picked.modelId }))
                    }
                  />
                </div>
              </Show>
            </div>
            <Show when={props.reasoning}>
              <div class="relative">
                <button
                  type="button"
                  onClick={() => toggleMenu("effort")}
                  aria-expanded={menu() === "effort"}
                  aria-haspopup="menu"
                  class={TOOL_BUTTON}
                >
                  <EffortBars level={props.effort} />
                  <span>{effortWord()}</span>
                </button>
                <Show when={menu() === "effort"}>
                  <MenuSurface class="absolute bottom-10 left-0 w-[180px]">
                    <GlideList active={props.effort} radius="4px">
                      <For each={THINKING_LEVELS}>
                        {(level) => (
                          <ChoiceRow
                            value={level}
                            label={EFFORT_WORD[level]}
                            checked={props.effort === level}
                            onPick={() => void choose(() => props.onPickEffort(level))}
                          />
                        )}
                      </For>
                    </GlideList>
                    <Show when={props.effort === undefined}>
                      <div class="px-2 pb-1 pt-1.5 text-[11.5px] text-fg-4">Using the model's own default</div>
                    </Show>
                  </MenuSurface>
                </Show>
              </div>
            </Show>
            <div class="flex-1" />
            <Show when={props.busy}>
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopping()}
                aria-label="Stop the run"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fg text-page hover:opacity-90 disabled:opacity-60"
              >
                <Icon name="stop" size={12} />
              </button>
            </Show>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={sending() || empty()}
              aria-label="Send message"
              class="grid h-8 w-8 shrink-0 place-items-center rounded-full"
              classList={{
                "bg-accent text-ink hover:opacity-90": !empty() && !sending(),
                "bg-fill-strong text-fg-4": empty() || sending(),
              }}
            >
              <Show when={sending()} fallback={<Icon name="arrow-up" size={16} />}>
                <Spinner class="text-ink" />
              </Show>
            </button>
          </div>
        </div>
        <Show when={error()}>
          {(message) => (
            <div class="shake mt-2 flex items-center gap-2 rounded-[8px] border border-failed/40 bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
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
        <Show when={props.busy}>
          <div class="mt-2 flex items-center gap-2 text-[11.5px] text-fg-4">
            <span class="ml-auto font-mono text-[11px] text-fg-3">The run is live · Stop ends it</span>
          </div>
        </Show>
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
      <div class="overflow-hidden rounded-[16px] border border-line-inner bg-raised focus-within:border-line-strong">
        <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[11.5px] text-fg-3">
          <Show
            when={props.busy}
            fallback={
              <span classList={{ "text-waiting": props.waiting }}>
                {props.waiting ? "Waiting on you" : "Finished"}
              </span>
            }
          >
            <span class="shimmer">Working</span>
          </Show>
          <span class="truncate font-mono text-[11px] text-fg-4">{props.threadTitle}</span>
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
          class="block max-h-[180px] min-h-[22px] w-full resize-none bg-transparent px-3.5 pb-1.5 pt-3 text-[14.5px] leading-[22px] text-fg outline-none placeholder:text-fg-4 disabled:opacity-60"
        />
        <div class="flex items-center gap-1 px-1.5 pb-1.5">
          <Show when={props.busy}>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping()}
              aria-label="Stop this thread"
              class="ml-auto grid h-7 w-7 place-items-center rounded-full bg-fg text-page disabled:opacity-60"
            >
              <Icon name="stop" size={11} />
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending() || props.waiting || draft().trim() === ""}
            aria-label="Send to thread"
            class="grid h-7 w-7 place-items-center rounded-full"
            classList={{
              "ml-auto": !props.busy,
              "bg-accent text-ink": draft().trim() !== "" && !props.waiting,
              "bg-fill-strong text-fg-4": draft().trim() === "" || props.waiting,
            }}
          >
            <Show when={sending()} fallback={<Icon name="arrow-up" size={14} />}>
              <Spinner class="text-ink" />
            </Show>
          </button>
        </div>
      </div>
      <Show when={error()}>
        {(message) => <div class="mt-2 text-[12.5px] text-bad">{message()}</div>}
      </Show>
    </div>
  )
}
