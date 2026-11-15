import { For, Show, createSignal, type JSX } from "solid-js"
import type { BatchRow, FailureData, RequestRow, ToolCallView } from "../../state/conversation.ts"
import type { ThreadSummary } from "../../state/home.ts"
import { STATE_WORD, visualState, type VisualState } from "../../lib/status.ts"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { StatusGlyph } from "../ui/status-glyph.tsx"
import { Icon } from "../ui/icon.tsx"
import { Markdown } from "./markdown.tsx"
import { Button, Spinner } from "./ui.tsx"

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

function threadTone(state: VisualState): string {
  switch (state) {
    case "waiting":
      return "text-primary-ink"
    case "failed":
      return "text-failed"
    default:
      return "text-ink-3"
  }
}

function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/[*_`#>]/gu, "")
    .replace(/^\s*[-+]\s+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function excerpt(text: string, limit = 120): string {
  const flat = plain(text)
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function threadLine(thread: ThreadSummary | undefined, state: VisualState): string {
  if (thread === undefined) return STATE_WORD[state]
  switch (state) {
    case "done":
    case "failed":
      return thread.result !== undefined && thread.result !== "" ? excerpt(thread.result) : STATE_WORD[state]
    case "cancelled":
      return STATE_WORD[state]
    default:
      return thread.statusLine !== undefined && thread.statusLine !== "" ? thread.statusLine : STATE_WORD[state]
  }
}

export function ThreadRow(props: {
  thread: ThreadSummary | undefined
  title: string
  role: string
  onClick?: () => void
  flush?: boolean
  index?: number
}): JSX.Element {
  const state = (): VisualState => (props.thread === undefined ? "queued" : visualState(props.thread.status))
  return (
    <button
      type="button"
      onClick={() => props.onClick?.()}
      style={props.index === undefined ? undefined : { "--i": props.index }}
      class="flex w-full items-start gap-2.5 bg-card px-2.5 py-2 text-left hover:bg-secondary disabled:cursor-default"
      classList={{
        "border-b border-line-1 last:border-b-0": props.flush === true,
        "border border-primary/40": props.flush !== true && state() === "waiting",
        "border border-line-2": props.flush !== true && state() !== "waiting",
        "rounded-sm": props.flush !== true,
      }}
    >
      <StatusGlyph state={state()} size={16} class="mt-px" />
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{props.title}</span>
          <span class="mono-meta shrink-0">{props.thread === undefined ? "—" : ago(props.thread.beatAt)}</span>
        </span>
        <span
          class={`mt-0.5 block truncate text-sm ${threadTone(state())}`}
          classList={{ "im-shimmer": state() === "working" }}
        >
          {threadLine(props.thread, state())}
        </span>
      </span>
      <Show when={props.role !== "thread"}>
        <span class="mono-meta mt-px shrink-0 uppercase">{props.role}</span>
      </Show>
    </button>
  )
}

export function ThreadFan(props: {
  calls: readonly ToolCallView[]
  threads: readonly ThreadSummary[]
  links: ReadonlyMap<string, number>
  onOpenThread: (id: number) => void
}): JSX.Element {
  const rows = (): readonly { call: ToolCallView; thread: ThreadSummary | undefined; title: string; role: string }[] =>
    props.calls.map((call) => {
      const created = call.id === undefined ? undefined : props.links.get(call.id)
      const thread =
        created === undefined
          ? props.threads.find((candidate) => candidate.title === argString(call.arguments, "title"))
          : props.threads.find((candidate) => candidate.id === created)
      const title = thread?.title ?? argString(call.arguments, "title") ?? "Untitled thread"
      const role = argString(call.arguments, "role") ?? thread?.role ?? "thread"
      return { call, thread, title, role }
    })

  const tally = (): string => {
    const counts = new Map<VisualState, number>()
    for (const row of rows()) {
      const state = row.thread === undefined ? "queued" : visualState(row.thread.status)
      counts.set(state, (counts.get(state) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([state, count]) => `${count} ${STATE_WORD[state].toLowerCase()}`)
      .join(" · ")
  }

  return (
    <Show
      when={rows().length > 1}
      fallback={
        <Show when={rows()[0]}>
          {(row) => (
            <div class="max-w-[560px]">
              <ThreadRow
                thread={row().thread}
                title={row().title}
                role={row().role}
                onClick={() => {
                  const thread = row().thread
                  if (thread !== undefined) props.onOpenThread(thread.id)
                }}
              />
            </div>
          )}
        </Show>
      }
    >
      <div class="max-w-[560px] overflow-hidden rounded-sm border border-line-2">
        <div class="flex items-center gap-2 border-b border-line-1 bg-card px-2.5 py-2">
          <span class="label flex-1">{rows().length} threads</span>
          <span class="mono-meta">{tally()}</span>
        </div>
        <div class="im-stagger">
          <For each={rows()}>
            {(row, index) => (
              <ThreadRow
                flush
                index={index()}
                thread={row.thread}
                title={row.title}
                role={row.role}
                onClick={() => {
                  if (row.thread !== undefined) props.onOpenThread(row.thread.id)
                }}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

export function ReportCard(props: { row: BatchRow; onOpenThread: (id: number) => void }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const state = (): VisualState => visualState(props.row.status === "" ? "completed" : props.row.status)
  const threadId = (): number | undefined => {
    const id = Number(props.row.threadId)
    return Number.isInteger(id) && id > 0 ? id : undefined
  }
  const long = (): boolean => props.row.text.length > 320

  return (
    <div class="im-event max-w-[560px] overflow-hidden rounded-md border border-line-2 bg-card">
      <div class="flex items-center gap-2.5 border-b border-line-1 px-3.5 py-2.5">
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{props.row.title}</span>
        <span class="mono-meta shrink-0">{STATE_WORD[state()]}</span>
      </div>
      <div class="relative px-3.5 py-3">
        <div class="overflow-hidden" classList={{ "max-h-none": expanded(), "max-h-[132px]": !expanded() }}>
          <div class="text-base leading-[1.6] text-ink-2">
            <Markdown muted text={props.row.text} />
          </div>
        </div>
        <Show when={long() && !expanded()}>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-card to-transparent" />
        </Show>
      </div>
      <div class="flex items-center gap-2 border-t border-line-1 px-3.5 py-2">
        <Show when={threadId()}>
          {(id) => <Button onClick={() => props.onOpenThread(id())}>View thread</Button>}
        </Show>
        <Show when={long()}>
          <Button variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded() ? "Show less" : "Show all"}
            <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={14} />
          </Button>
        </Show>
        <span class="ml-auto mono-meta">{props.row.status === "" ? "report" : props.row.status}</span>
      </div>
    </div>
  )
}

export function QuestionInboundCard(props: {
  row: BatchRow
  thread: ThreadSummary | undefined
  onOpenThread: (id: number) => void
}): JSX.Element {
  const threadId = (): number | undefined => {
    const id = Number(props.row.threadId)
    return Number.isInteger(id) && id > 0 ? id : undefined
  }
  const state = (): VisualState => (props.thread === undefined ? "waiting" : visualState(props.thread.status))
  const label = (): string => {
    if (props.thread === undefined) return "Needs your answer"
    if (props.thread.status === "completed") return "Answered"
    return props.thread.statusLine ?? STATE_WORD[state()]
  }
  return (
    <div
      class="max-w-[560px] overflow-hidden rounded-md border bg-card"
      classList={{ "border-primary/40": state() === "waiting", "border-line-2": state() !== "waiting" }}
    >
      <div
        class="flex items-center gap-2.5 border-b px-3.5 py-2.5"
        classList={{ "border-primary/40 bg-primary-soft": state() === "waiting", "border-line-1": state() !== "waiting" }}
      >
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{props.row.title}</span>
        <span class="text-2xs" classList={{ "text-primary-ink": state() === "waiting", "text-ink-3": state() !== "waiting" }}>
          {label()}
        </span>
      </div>
      <div class="px-3.5 py-3 text-base leading-[1.6] text-ink">{props.row.text}</div>
      <div class="flex items-center gap-2 border-t border-line-1 px-3.5 py-2">
        <Show when={threadId()}>
          {(id) => (
            <Button variant="primary" onClick={() => props.onOpenThread(id())}>
              Open thread
            </Button>
          )}
        </Show>
        <Show when={state() === "waiting"}>
          <span class="ml-auto mono-meta">Choices arrive on the thread card</span>
        </Show>
      </div>
    </div>
  )
}

export function JobCard(props: { row: BatchRow; onOpenThread: (id: number) => void }): JSX.Element {
  const state = (): VisualState => visualState(props.row.status === "" ? "working" : props.row.status)
  const threadId = (): number | undefined => {
    const id = Number(props.row.threadId)
    return Number.isInteger(id) && id > 0 ? id : undefined
  }
  return (
    <div class="max-w-[560px] overflow-hidden rounded-md border border-line-2 bg-card">
      <div class="flex items-center gap-2.5 border-b border-line-1 px-3.5 py-2.5">
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{props.row.title}</span>
        <span class="mono-meta shrink-0">{STATE_WORD[state()]}</span>
      </div>
      <div class="px-3.5 py-3 text-base leading-[1.6] text-ink-2">
        <Markdown muted text={props.row.text} />
      </div>
      <Show when={threadId()}>
        {(id) => (
          <div class="flex items-center gap-2 border-t border-line-1 px-3.5 py-2">
            <Button onClick={() => props.onOpenThread(id())}>Open thread</Button>
          </div>
        )}
      </Show>
    </div>
  )
}

export function FailureCard(props: { failure: FailureData; onRetry: () => Promise<void> }): JSX.Element {
  const [retrying, setRetrying] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const retry = async (): Promise<void> => {
    if (retrying()) return
    setRetrying(true)
    setError(undefined)
    try {
      await props.onRetry()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div class="overflow-hidden rounded-md border border-failed/40 bg-card">
      <div class="flex items-center gap-2.5 border-b border-failed/30 px-3.5 py-2.5">
        <StatusGlyph state="failed" size={16} />
        <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">The turn failed</span>
        <span class="mono-meta shrink-0">{props.failure.reason}</span>
      </div>
      <pre class="m-0 whitespace-pre-wrap border-b border-line-1 bg-panel px-3.5 py-2.5 font-mono text-sm leading-[1.6] text-failed">
        {props.failure.error}
      </pre>
      <div class="flex items-center gap-2 px-3.5 py-2">
        <Button onClick={() => void retry()} disabled={retrying()}>
          <Show when={retrying()} fallback={<Icon name="refresh" size={14} />}>
            <Spinner />
          </Show>
          Retry
        </Button>
        <span class="mono-meta">
          {props.failure.batchId === undefined ? "Nothing to resubmit" : "Resubmits the message that failed"}
        </span>
        <Show when={error()}>
          <span class="ml-auto truncate text-sm text-failed">{error()}</span>
        </Show>
      </div>
    </div>
  )
}

export function OpenQuestionCard(props: {
  title: string
  request: RequestRow
  onAnswer: (requestId: string, answer: string) => Promise<void>
}): JSX.Element {
  const [answer, setAnswer] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  const submit = async (value: string): Promise<void> => {
    const answer_ = value.trim()
    if (answer_ === "" || sending()) return
    setSending(true)
    setError(undefined)
    try {
      await props.onAnswer(props.request.id, answer_)
      setAnswer("")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <div class="overflow-hidden rounded-md border border-primary/40 bg-card">
      <div class="flex items-center gap-2.5 border-b border-primary/40 bg-primary-soft px-3 py-2.5">
        <StatusGlyph state="waiting" size={16} />
        <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{props.title}</span>
        <span class="text-2xs text-primary-ink">{ago(props.request.askedAt)}</span>
      </div>
      <div class="flex flex-col gap-2 px-3 py-3">
        <div class="text-base leading-[1.6] text-ink">{props.request.question}</div>
        <For each={props.request.options}>
          {(option, index) => (
            <button
              type="button"
              disabled={sending()}
              onClick={() => void submit(option)}
              class="flex items-center gap-2.5 rounded-sm border border-line-2 bg-panel px-3 py-2 text-left hover:border-line-3 hover:bg-secondary disabled:opacity-60"
            >
              <span class="w-3 font-mono text-2xs text-icon">{index() + 1}</span>
              <span class="min-w-0 flex-1 text-base text-ink">{option}</span>
            </button>
          )}
        </For>
        <div class="flex h-9 items-center gap-2 rounded-sm border border-line-2 bg-panel pl-3 pr-1">
          <input
            value={answer()}
            disabled={sending()}
            onInput={(event) => setAnswer(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                void submit(answer())
              }
            }}
            placeholder="Something else…"
            class="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-icon"
          />
          <button
            type="button"
            disabled={sending() || answer().trim() === ""}
            onClick={() => void submit(answer())}
            class="grid h-7 w-7 place-items-center rounded-sm text-ink-2 hover:bg-secondary hover:text-ink disabled:text-icon"
            aria-label="Send answer"
          >
            <Show when={sending()} fallback={<Icon name="arrow-up" size={14} />}>
              <Spinner />
            </Show>
          </button>
        </div>
        <Show when={error()}>
          <div class="text-sm text-failed">{error()}</div>
        </Show>
        <Show when={sending()}>
          <div class="text-sm text-ink-3">Sending your answer…</div>
        </Show>
      </div>
    </div>
  )
}

export function AnsweredQuestionCard(props: {
  question: string
  answer: string
  answeredAt: number
}): JSX.Element {
  return (
    <div class="overflow-hidden rounded-md border border-line-2 bg-card">
      <div class="flex items-center gap-2.5 border-b border-line-1 px-3 py-2">
        <StatusGlyph state="done" size={16} />
        <span class="min-w-0 flex-1 truncate text-sm text-ink-2">{props.question}</span>
        <span class="mono-meta shrink-0">answered · {ago(props.answeredAt)}</span>
      </div>
      <div class="flex items-center gap-2 px-3 py-2">
        <Icon name="check" size={14} class="text-done" />
        <span class="text-base text-ink">{props.answer}</span>
      </div>
    </div>
  )
}

export function SystemNotice(props: { text: string }): JSX.Element {
  return (
    <div class="flex items-center gap-2.5 text-sm text-ink-3">
      <span class="h-px flex-1 bg-line-1" />
      <span class="whitespace-nowrap">{props.text}</span>
      <span class="h-px flex-1 bg-line-1" />
    </div>
  )
}
