import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { takePendingDraft } from "../../lib/draft.ts"
import { MAX_UPLOAD_BYTES, type UploadedFile } from "../../lib/api.ts"
import { THINKING_LEVELS, type ThinkingLevel } from "../../state/conversation.ts"
import type { PresetRow } from "../../state/extensions.ts"
import { priceMarks, type ModelInfo, type ModelRef } from "../../state/settings.ts"
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

const TOOL_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-[2px] px-2 text-[12px] text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-50"
const TOOL_MENU =
  "menu-in absolute bottom-10 left-0 z-30 max-h-[320px] overflow-y-auto rounded-[4px] border border-line-inner bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.6)]"

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

/** One quiet text button with its popover, so every toolbar control opens the same way. */
function ToolButton(props: {
  name: string
  role: "menu" | "dialog"
  width: string
  open: boolean
  onToggle: () => void
  trigger: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="relative">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        aria-haspopup={props.role}
        class={TOOL_BUTTON}
      >
        {props.trigger}
      </button>
      <Show when={props.open}>
        <div role={props.role} aria-label={props.name} class={`${TOOL_MENU} ${props.width}`}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}

function ChoiceRow(props: {
  label: string
  detail?: string | undefined
  checked: boolean
  disabled?: boolean | undefined
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.checked}
      disabled={props.disabled === true}
      onClick={props.onPick}
      class="flex w-full items-start gap-2 rounded-[2px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
      classList={{ "bg-selected": props.checked }}
    >
      <span class="min-w-0 flex-1">
        <span class="block truncate">{props.label}</span>
        <Show when={props.detail}>
          {(text) => <span class="block truncate text-[11px] text-fg-3">{text()}</span>}
        </Show>
      </span>
      <Show when={props.checked}>
        <Icon name="check" size={12} class="mt-0.5 shrink-0 text-fg-3" />
      </Show>
    </button>
  )
}

function ModelChoice(props: { model: ModelInfo; onPick: (model: ModelInfo) => void }): JSX.Element {
  const keyed = (): boolean => props.model.keyed
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      aria-disabled={!keyed()}
      onClick={() => {
        if (keyed()) props.onPick(props.model)
      }}
      class="flex w-full items-center gap-2 rounded-[2px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover"
      classList={{ "cursor-default opacity-45 hover:bg-transparent": !keyed() }}
    >
      <span class="min-w-0 flex-1 truncate">{props.model.name}</span>
      <Show when={priceMarks(props.model.cost)}>
        {(marks) => <span class="shrink-0 font-mono text-[10.5px] text-fg-3">{marks()}</span>}
      </Show>
      <Show
        when={!keyed()}
        fallback={<span class="mono-meta max-w-[90px] shrink-0 truncate">{props.model.provider}</span>}
      >
        <span class="shrink-0 font-mono text-[10.5px] text-fg-3">no key</span>
      </Show>
    </button>
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
  const otherModels = (): readonly ModelInfo[] => {
    const ref = props.model
    return props.models.filter(
      (model) => ref === undefined || model.provider !== ref.provider || model.modelId !== ref.modelId,
    )
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
    <div class="shrink-0 px-6 pb-4 pt-3">
      <div class="mx-auto w-full max-w-[720px]">
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
          <Show when={toolError()}>
            {(message) => <div class="px-3 pb-1 text-[12px] text-bad">{message()}</div>}
          </Show>
          <div ref={bar} class="flex items-center gap-0.5 px-2 pb-2 pt-1.5">
            <button
              type="button"
              onClick={() => fileInput.click()}
              disabled={uploading()}
              title="Attach a file"
              aria-label="Attach a file"
              class="grid h-8 w-8 place-items-center rounded-[2px] text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-50"
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
            <span class="mx-1 h-2.5 w-px bg-line-inner" aria-hidden="true" />
            <Show when={props.presets.length > 0}>
              <ToolButton
                name="Preset"
                role="menu"
                width="w-[280px]"
                open={menu() === "preset"}
                onToggle={() => toggleMenu("preset")}
                trigger={
                  <>
                    <Icon name="layers" size={13} class="shrink-0 text-fg-3" />
                    <span class="max-w-[120px] truncate">{presetLabel()}</span>
                  </>
                }
              >
                <Show when={props.presetLocked}>
                  <div class="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-fg-4">
                    This conversation has started, so its preset is fixed.
                  </div>
                </Show>
                <For each={props.presets}>
                  {(preset) => (
                    <ChoiceRow
                      label={preset.name}
                      detail={preset.description}
                      checked={preset.id === props.presetId}
                      disabled={props.presetLocked}
                      onPick={() => void choose(() => props.onPickPreset(preset.id))}
                    />
                  )}
                </For>
              </ToolButton>
              <span class="mx-1 h-2.5 w-px bg-line-inner" aria-hidden="true" />
            </Show>
            <ToolButton
              name="Choose a model"
              role="dialog"
              width="w-[320px]"
              open={menu() === "model"}
              onToggle={() => toggleMenu("model")}
              trigger={
                <>
                  <span class="max-w-[220px] truncate">{props.modelLabel}</span>
                  <Icon name="chevron-down" size={12} class="text-fg-4" />
                </>
              }
            >
              <Show when={props.models.length > 12 || props.query !== ""}>
                <input
                  type="text"
                  value={props.query}
                  aria-label="Search models"
                  placeholder="Search models"
                  class="mb-1 h-7 w-full rounded-[2px] border border-line-inner bg-raised px-2 text-[12px] text-fg outline-none placeholder:text-fg-4 focus:border-line-strong"
                  onInput={(event) => props.onSearch(event.currentTarget.value)}
                />
              </Show>
              <Show
                when={props.models.length > 0}
                fallback={<div class="px-2.5 py-2 text-[12px] text-fg-3">No models yet. Add a provider key in Settings.</div>}
              >
                <div role="listbox" aria-label="Models">
                  <Show when={props.model !== undefined && props.query === ""}>
                    <div role="group" aria-label="This project">
                      <div class="label px-2.5 pb-1 pt-1.5" aria-hidden="true">
                        This project
                      </div>
                      <button
                        type="button"
                        role="option"
                        aria-selected="true"
                        class="flex w-full items-center gap-2 rounded-[2px] bg-selected px-2.5 py-1.5 text-left text-[12.5px]"
                      >
                        <span class="min-w-0 flex-1 truncate">{props.modelLabel}</span>
                        <Icon name="check" size={12} class="shrink-0 text-fg-3" />
                      </button>
                    </div>
                  </Show>
                  <div role="group" aria-label="Catalog">
                    <div class="label px-2.5 pb-1 pt-2" aria-hidden="true">
                      Catalog
                    </div>
                    <For each={otherModels()}>
                      {(model) => (
                        <ModelChoice
                          model={model}
                          onPick={(picked) =>
                            void choose(() =>
                              props.onPickModel({ provider: picked.provider, modelId: picked.modelId }),
                            )
                          }
                        />
                      )}
                    </For>
                  </div>
                </div>
                <Show when={otherModels().length === 0}>
                  <div class="px-2.5 py-2 text-[12px] text-fg-3">
                    {props.query.trim() === "" ? "No other models to pick." : "No model matches that."}
                  </div>
                </Show>
                <Show when={props.omitted > 0 && props.query.trim() === ""}>
                  <div class="px-2.5 py-2 text-[11px] text-fg-4">
                    {props.omitted} more · search to narrow the list
                  </div>
                </Show>
              </Show>
            </ToolButton>
            <Show when={props.reasoning}>
              <span class="mx-1 h-2.5 w-px bg-line-inner" aria-hidden="true" />
              <ToolButton
                name="Effort"
                role="menu"
                width="w-[180px]"
                open={menu() === "effort"}
                onToggle={() => toggleMenu("effort")}
                trigger={
                  <>
                    <EffortBars level={props.effort} />
                    <span>{effortWord()}</span>
                  </>
                }
              >
                <For each={THINKING_LEVELS}>
                  {(level) => (
                    <ChoiceRow
                      label={EFFORT_WORD[level]}
                      checked={props.effort === level}
                      onPick={() => void choose(() => props.onPickEffort(level))}
                    />
                  )}
                </For>
                <Show when={props.effort === undefined}>
                  <div class="px-2.5 pb-1 pt-1 text-[11px] text-fg-4">Using the model's own default</div>
                </Show>
              </ToolButton>
            </Show>
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
                <Spinner class="text-ink" />
              </Show>
            </button>
          </div>
        </div>
        <Show when={error()}>
          {(message) => (
            <div class="shake mt-2 flex items-center gap-2 rounded-[2px] border border-failed/40 bg-bad-bg px-3 py-2 text-[12px] text-bad">
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
              <Spinner class="text-ink" />
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
