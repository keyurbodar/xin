import { ArrowUp, Square, X } from "lucide-solid"
import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { takePendingDraft } from "../../lib/draft.ts"
import type { UploadedFile } from "../../lib/api.ts"
import type { ThinkingLevel } from "../../state/conversation.ts"
import type { PresetRow } from "../../state/extensions.ts"
import type { ProjectSummary } from "../../state/home.ts"
import type { ModelInfo, ModelRef } from "../../state/settings.ts"
import { AttachmentGrid, useAttachments, type Upload } from "../composer/attachments.tsx"
import { ContextMeter } from "../composer/context-meter.tsx"
import { ModelPicker } from "../composer/model-picker.tsx"
import { PlusMenu } from "../composer/plus-menu.tsx"
import { ReasoningMenu } from "../composer/reasoning-menu.tsx"
import "../composer/composer.css"
import { Spinner } from "./ui.tsx"

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function useGrow(max: number): {
  ref: (element: HTMLTextAreaElement) => void
  resize: () => void
} {
  let element: HTMLTextAreaElement | undefined
  const resize = (): void => {
    if (element === undefined) return
    element.style.height = "auto"
    const content = element.scrollHeight
    if (content === 0) return
    element.style.height = `${Math.min(content, max)}px`
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

function useStopper(onStop: () => Promise<void>, onError: (message: string | undefined) => void) {
  const [stopping, setStopping] = createSignal(false)
  const stop = async (): Promise<boolean> => {
    if (stopping()) return true
    setStopping(true)
    onError(undefined)
    try {
      await onStop()
      return true
    } catch (failure) {
      onError(errorText(failure))
      return false
    } finally {
      setStopping(false)
    }
  }
  return { stopping, stop }
}

/** Send while there is something to send; Stop while the run is live and the draft is empty. */
function SendButton(props: {
  stop: boolean
  ready: boolean
  pending: boolean
  size: "base" | "sm"
  label: string
  onSend: () => void
  onStop: () => void
}): JSX.Element {
  const box = (): string => (props.size === "base" ? "h-8 w-8" : "h-7 w-7")
  return (
    <button
      type="button"
      onClick={() => (props.stop ? props.onStop() : props.onSend())}
      disabled={props.pending || (!props.stop && !props.ready)}
      aria-label={props.stop ? "Stop the run" : props.label}
      class={`composer-press relative grid ${box()} shrink-0 place-items-center rounded-sm transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-enter)] disabled:cursor-default`}
      classList={{
        "bg-inverse text-on-inverse": props.stop,
        "bg-primary text-on-primary": !props.stop && props.ready,
        "bg-secondary text-icon": !props.stop && !props.ready,
      }}
    >
      <Show when={props.pending} fallback={
        <>
          <span class="composer-send-icon absolute inset-0 grid place-items-center" data-shown={String(!props.stop)}>
            <ArrowUp size={16} stroke-width={2} />
          </span>
          <span class="composer-send-icon absolute inset-0 grid place-items-center" data-shown={String(props.stop)}>
            <Square size={11} stroke-width={0} fill="currentColor" />
          </span>
        </>
      }>
        <Spinner />
      </Show>
    </button>
  )
}

function ErrorLine(props: { message: string; onRetry?: (() => void) | undefined; onDismiss: () => void }): JSX.Element {
  return (
    <div class="shake mt-2 flex items-center gap-2 rounded-md bg-failed-soft px-3 py-2 text-sm text-failed">
      <span class="min-w-0 flex-1 truncate">{props.message}</span>
      <Show when={props.onRetry}>
        {(retry) => (
          <button type="button" class="link" onClick={() => retry()()}>
            Retry
          </button>
        )}
      </Show>
      <button type="button" aria-label="Dismiss" class="grid h-5 w-5 place-items-center rounded-xs hover:bg-hover" onClick={() => props.onDismiss()}>
        <X size={12} stroke-width={1.5} />
      </button>
    </div>
  )
}

export function Composer(props: {
  project: ProjectSummary
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
  onAttach: Upload
}): JSX.Element {
  const [draft, setDraft] = createSignal(takePendingDraft() ?? "")
  const [error, setError] = createSignal<{ readonly message: string; readonly retry: "send" | "stop" | undefined }>()
  const [dragging, setDragging] = createSignal(false)
  const { sending, send } = useSender(props.onSend, () => false)
  const attachments = useAttachments(() => props.onAttach)
  const { stopping, stop } = useStopper(props.onStop, (message) =>
    setError(message === undefined ? undefined : { message, retry: "stop" }),
  )
  const grow = useGrow(320)
  let textarea!: HTMLTextAreaElement
  let fileInput!: HTMLInputElement

  const pickFiles = (): void => fileInput.click()

  onMount(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault()
        pickFiles()
      }
    }
    document.addEventListener("keydown", shortcut)
    onCleanup(() => document.removeEventListener("keydown", shortcut))
  })

  const insert = (text: string): void => {
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const current = draft()
    const before = current.slice(0, start)
    const spacer = before === "" || /\s$/u.test(before) ? "" : " "
    const next = `${before}${spacer}${text}${current.slice(end)}`
    setDraft(next)
    queueMicrotask(() => {
      const caret = before.length + spacer.length + text.length
      textarea.focus()
      textarea.setSelectionRange(caret, caret)
      grow.resize()
    })
  }

  const applyPrompt = (name: string): void => {
    const command = `/${name} `
    const rest = draft().replace(/^\/[a-z][a-z0-9-]*(?:\s+|$)/u, "").trimStart()
    setDraft(`${command}${rest}`)
    queueMicrotask(() => {
      textarea.focus()
      textarea.setSelectionRange(command.length, command.length)
      grow.resize()
    })
  }

  const run = async (work: () => Promise<void>): Promise<void> => {
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError({ message: errorText(failure), retry: undefined })
    }
  }

  const empty = (): boolean => draft().trim() === "" && attachments.uploaded().length === 0
  const ready = (): boolean => !empty() && !attachments.uploading() && !sending()
  const showStop = (): boolean => props.busy && empty()

  const submit = async (): Promise<void> => {
    if (!ready()) return
    setError(undefined)
    try {
      if (await send(draft().trim(), attachments.uploaded())) {
        setDraft("")
        attachments.clear()
        grow.resize()
      }
    } catch (failure) {
      setError({ message: errorText(failure), retry: "send" })
    }
  }

  const filesOf = (list: FileList | null | undefined): readonly File[] => (list === null || list === undefined ? [] : Array.from(list))

  return (
    <div class="shrink-0 px-4 pb-3 pt-2">
      <div class="mx-auto w-full max-w-[var(--w-column)]">
        <div
          class="rounded-lg bg-card shadow-composer transition-shadow duration-[var(--dur-fast)]"
          classList={{ "shadow-[0_0_0_1px_var(--color-primary)]": dragging() }}
          onDragOver={(event) => {
            if (!event.dataTransfer?.types.includes("Files")) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
            setDragging(false)
          }}
          onDrop={(event) => {
            const dropped = filesOf(event.dataTransfer?.files)
            setDragging(false)
            if (dropped.length === 0) return
            event.preventDefault()
            attachments.add(dropped)
          }}
        >
          <textarea
            ref={(element) => {
              textarea = element
              grow.ref(element)
            }}
            value={draft()}
            rows={1}
            disabled={sending()}
            onInput={(event) => {
              setDraft(event.currentTarget.value)
              grow.resize()
            }}
            onPaste={(event) => {
              const pasted = filesOf(event.clipboardData?.files)
              if (pasted.length === 0) return
              event.preventDefault()
              attachments.add(pasted)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder="Ask anything, / for commands, @ for context"
            aria-label={`Message ${props.project.name}`}
            class="block min-h-[48px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-base text-ink outline-none placeholder:text-placeholder disabled:opacity-60"
          />
          <AttachmentGrid items={attachments.items()} onRemove={attachments.remove} />
          <div class="flex items-center gap-0.5 px-2 pb-2 pt-1">
            <PlusMenu
              project={props.project}
              disabled={sending()}
              onUpload={pickFiles}
              onInsert={insert}
              onPrompt={applyPrompt}
            />
            <input
              ref={fileInput}
              type="file"
              multiple
              class="hidden"
              onChange={(event) => {
                attachments.add(filesOf(event.currentTarget.files))
                event.currentTarget.value = ""
              }}
            />
            <ModelPicker
              label={props.modelLabel}
              current={props.model}
              models={props.models}
              omitted={props.omitted}
              query={props.query}
              onSearch={props.onSearch}
              onPick={(model) => void run(() => props.onPickModel(model))}
            />
            <ReasoningMenu
              reasoning={props.reasoning}
              level={props.effort}
              presets={props.presets}
              presetId={props.presetId}
              presetLocked={props.presetLocked}
              onLevel={(level) => void run(() => props.onPickEffort(level))}
              onPreset={(id) => void run(() => props.onPickPreset(id))}
            />
            <div class="ml-auto flex items-center gap-1.5">
              <ContextMeter conversation={props.project.coordinatorId} busy={props.busy} />
              <SendButton
                stop={showStop()}
                ready={ready()}
                pending={sending() || stopping()}
                size="base"
                label="Send message"
                onSend={() => void submit()}
                onStop={() => void stop()}
              />
            </div>
          </div>
        </div>
        <Show when={error()}>
          {(failure) => (
            <ErrorLine
              message={failure().message}
              onRetry={
                failure().retry === "stop" ? () => void stop() : failure().retry === "send" ? () => void submit() : undefined
              }
              onDismiss={() => setError(undefined)}
            />
          )}
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
  const [error, setError] = createSignal<string | undefined>()
  const { sending, send } = useSender(props.onSend, () => props.waiting)
  const { stopping, stop } = useStopper(props.onStop, setError)
  const grow = useGrow(180)

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

  const ready = (): boolean => draft().trim() !== "" && !props.waiting && !sending()

  return (
    <div class="shrink-0 border-t border-line-1 p-3">
      <div class="rounded-lg bg-card shadow-composer">
        <div class="flex items-center gap-2 border-b border-line-1 px-3 py-2 text-xs text-ink-3">
          <Show
            when={props.busy}
            fallback={
              <span classList={{ "text-primary-ink": props.waiting }}>
                {props.waiting ? "Waiting on you" : "Finished"}
              </span>
            }
          >
            <span class="shimmer">Working</span>
          </Show>
          <span class="truncate text-xs text-icon">{props.threadTitle}</span>
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
          class="block min-h-[22px] w-full resize-none bg-transparent px-3 pb-1.5 pt-2.5 text-base text-ink outline-none placeholder:text-placeholder disabled:opacity-60"
        />
        <div class="flex items-center justify-end px-1.5 pb-1.5">
          <SendButton
            stop={props.busy && draft().trim() === ""}
            ready={ready()}
            pending={sending() || stopping()}
            size="sm"
            label="Send to thread"
            onSend={() => void submit()}
            onStop={() => void stop()}
          />
        </div>
      </div>
      <Show when={error()}>{(message) => <div class="mt-2 text-sm text-failed">{message()}</div>}</Show>
    </div>
  )
}
