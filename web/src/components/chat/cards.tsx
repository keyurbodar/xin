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
      return "text-accent-text"
    case "failed":
      return "text-bad"
    default:
      return "text-fg-3"
  }
}

export function plain(text: string): string {
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
}): JSX.Element {
  const state = (): VisualState => (props.thread === undefined ? "queued" : visualState(props.thread.status))
  return (
    <button
      type="button"
      onClick={() => props.onClick?.()}
      class="flex w-full items-start gap-2.5 bg-raised px-2.5 py-2 text-left transition-none hover:bg-hover disabled:cursor-default"
      classList={{
        "border-b border-line last:border-b-0": props.flush === true,
        "border border-accent-line": props.flush !== true && state() === "waiting",
        "border border-line-inner": props.flush !== true && state() !== "waiting",
        "rounded-[2px]": props.flush !== true,
      }}
    >
      <StatusGlyph state={state()} size={16} class="mt-px" />
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{props.title}</span>
          <span class="mono-meta shrink-0">{props.thread === undefined ? "—" : ago(props.thread.beatAt)}</span>
        </span>
        <span
          class={`mt-0.5 block truncate text-[12px] ${threadTone(state())}`}
          classList={{ shimmer: state() === "working" }}
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
      <div class="max-w-[560px] overflow-hidden rounded-[2px] border border-line-inner">
        <div class="flex items-center gap-2 border-b border-line bg-raised px-2.5 py-2">
          <span class="label flex-1">{rows().length} threads</span>
          <span class="mono-meta">{tally()}</span>
        </div>
        <For each={rows()}>
          {(row) => (
            <ThreadRow
              flush
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
    <div class="max-w-[560px] overflow-hidden rounded-[4px] border border-line-inner bg-raised">
      <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{props.row.title}</span>
        <span class="mono-meta shrink-0">{STATE_WORD[state()]}</span>
      </div>
      <div class="relative px-3.5 py-3">
        <div class="overflow-hidden" classList={{ "max-h-none": expanded(), "max-h-[132px]": !expanded() }}>
          <div class="text-[13px] leading-[1.6] text-fg-2">
            <Markdown muted text={props.row.text} />
          </div>
        </div>
        <Show when={long() && !expanded()}>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-raised to-transparent" />
        </Show>
      </div>
      <div class="flex items-center gap-2 border-t border-line px-3.5 py-2">
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
      class="max-w-[560px] overflow-hidden rounded-[4px] border bg-raised"
      classList={{ "border-accent-line": state() === "waiting", "border-line-inner": state() !== "waiting" }}
    >
      <div
        class="flex items-center gap-2.5 border-b px-3.5 py-2.5"
        classList={{ "border-accent-line bg-accent-dim": state() === "waiting", "border-line": state() !== "waiting" }}
      >
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{props.row.title}</span>
        <span class="text-[11px]" classList={{ "text-accent-text": state() === "waiting", "text-fg-3": state() !== "waiting" }}>
          {label()}
        </span>
      </div>
      <div class="px-3.5 py-3 text-[13.5px] leading-[1.6] text-fg">{props.row.text}</div>
      <div class="flex items-center gap-2 border-t border-line px-3.5 py-2">
        <Show when={threadId()}>
          {(id) => (
            <Button variant="primary" onClick={() => props.onOpenThread(id())}>
              Open thread
            </Button>
          )}
        </Show>
        <Show when={state() === "waiting"}>
          <Button variant="ghost" onClick={() => navigate("/inbox")}>
            Answer in Inbox
          </Button>
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
    <div class="max-w-[560px] overflow-hidden rounded-[4px] border border-line-inner bg-raised">
      <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{props.row.title}</span>
        <span class="mono-meta shrink-0">{STATE_WORD[state()]}</span>
      </div>
      <div class="px-3.5 py-3 text-[13px] leading-[1.6] text-fg-2">
        <Markdown muted text={props.row.text} />
      </div>
      <Show when={threadId()}>
        {(id) => (
          <div class="flex items-center gap-2 border-t border-line px-3.5 py-2">
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
    <div class="overflow-hidden rounded-[4px] border border-failed/40 bg-raised">
      <div class="flex items-center gap-2.5 border-b border-failed/30 px-3.5 py-2.5">
        <StatusGlyph state="failed" size={16} />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">The turn failed</span>
        <span class="mono-meta shrink-0">{props.failure.reason}</span>
      </div>
      <pre class="m-0 whitespace-pre-wrap border-b border-line bg-surface px-3.5 py-2.5 font-mono text-[12px] leading-[1.6] text-bad">
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
          <span class="ml-auto truncate text-[12px] text-bad">{error()}</span>
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
    <div class="overflow-hidden rounded-[4px] border border-accent-line bg-raised">
      <div class="flex items-center gap-2.5 border-b border-accent-line bg-accent-dim px-3 py-2.5">
        <StatusGlyph state="waiting" size={16} />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{props.title}</span>
        <span class="text-[11px] text-accent-text">{ago(props.request.askedAt)}</span>
      </div>
      <div class="flex flex-col gap-2 px-3 py-3">
        <div class="text-[13.5px] leading-[1.6] text-fg">{props.request.question}</div>
        <For each={props.request.options}>
          {(option, index) => (
            <button
              type="button"
              disabled={sending()}
              onClick={() => void submit(option)}
              class="flex items-center gap-2.5 rounded-[2px] border border-line-inner bg-surface px-3 py-2 text-left transition-none hover:border-line-strong hover:bg-hover disabled:opacity-60"
            >
              <span class="w-3 font-mono text-[10px] text-fg-4">{index() + 1}</span>
              <span class="min-w-0 flex-1 text-[13px] text-fg">{option}</span>
            </button>
          )}
        </For>
        <div class="flex h-9 items-center gap-2 rounded-[2px] border border-line-inner bg-surface pl-3 pr-1">
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
            class="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4"
          />
          <button
            type="button"
            disabled={sending() || answer().trim() === ""}
            onClick={() => void submit(answer())}
            class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-4"
            aria-label="Send answer"
          >
            <Show when={sending()} fallback={<Icon name="arrow-up" size={14} />}>
              <Spinner />
            </Show>
          </button>
        </div>
        <Show when={error()}>
          <div class="text-[12px] text-bad">{error()}</div>
        </Show>
        <Show when={sending()}>
          <div class="text-[12px] text-fg-3">Sending your answer…</div>
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
    <div class="overflow-hidden rounded-[4px] border border-line-inner bg-raised">
      <div class="flex items-center gap-2.5 border-b border-line px-3 py-2">
        <StatusGlyph state="done" size={16} />
        <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{props.question}</span>
        <span class="mono-meta shrink-0">answered · {ago(props.answeredAt)}</span>
      </div>
      <div class="flex items-center gap-2 px-3 py-2">
        <Icon name="check" size={14} class="text-ok" />
        <span class="text-[13px] text-fg">{props.answer}</span>
      </div>
    </div>
  )
}

export function SystemNotice(props: { text: string }): JSX.Element {
  return (
    <div class="flex items-center gap-2.5 text-[12px] text-fg-3">
      <span class="h-px flex-1 bg-line" />
      <span class="whitespace-nowrap">{props.text}</span>
      <span class="h-px flex-1 bg-line" />
    </div>
  )
}
