import { For, Show, type JSX } from "solid-js"
import {
  type Attachment,
  entryBatchRows,
  entryFailure,
  entryText,
  entryToolCalls,
  type BatchRow,
  type EntryView,
  type FailureData,
  type RequestRow,
  type ToolCallView,
} from "../../state/conversation.ts"
import type { ThreadSummary } from "../../state/home.ts"
import { SentAttachments } from "../composer/attachment-card.tsx"
import { FailureCard, JobCard, OpenQuestionCard, QuestionInboundCard, ReportCard, SystemNotice } from "./cards.tsx"
import type { PassItem } from "./timeline/model.ts"

type EntryItemBody =
  | { readonly kind: "owner"; readonly text: string; readonly attachments: readonly Attachment[] }
  | { readonly kind: "assistant"; readonly text: string; readonly calls: readonly ToolCallView[] }
  | { readonly kind: "report"; readonly row: BatchRow }
  | { readonly kind: "question"; readonly row: BatchRow }
  | { readonly kind: "job"; readonly row: BatchRow }
  | { readonly kind: "failure"; readonly entryId: number; readonly failure: FailureData }
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "tool"; readonly call: ToolCallView }

export type EntryItem = EntryItemBody & { readonly entryId: number }

/** One entry becomes one stable group of items, cached by the entry view `For` keys on. */
const ITEM_CACHE = new WeakMap<EntryView, readonly EntryItem[]>()

function entryItems(entry: EntryView): readonly EntryItem[] {
  const cached = ITEM_CACHE.get(entry)
  if (cached !== undefined) return cached
  const items: EntryItemBody[] = []
  if (entry.kind === "xin.batch") {
    for (const row of entryBatchRows(entry)) {
      switch (row.kind) {
        case "user":
          if (row.text.trim() !== "" || row.attachments.length > 0)
            items.push({ kind: "owner", text: row.text, attachments: row.attachments })
          break
        case "report":
          items.push({ kind: "report", row })
          break
        case "question":
          items.push({ kind: "question", row })
          break
        case "job":
          items.push({ kind: "job", row })
          break
        default: {
          const _exhaustive: never = row.kind
          return _exhaustive
        }
      }
    }
  } else if (entry.kind === "xin.error") {
    const failure = entryFailure(entry)
    if (failure !== undefined) items.push({ kind: "failure", entryId: entry.id, failure })
  } else if (entry.kind === "pi.user") {
    const text = entryText(entry)
    if (text !== "") items.push({ kind: "owner", text, attachments: [] })
  } else if (entry.kind === "pi.assistant") {
    const text = entryText(entry)
    const calls = entryToolCalls(entry)
    const delegated = calls.filter((call) => call.name === "delegate_task")
    if (text !== "" || delegated.length > 0) items.push({ kind: "assistant", text, calls: delegated })
    for (const call of calls) if (call.name !== "delegate_task") items.push({ kind: "tool", call })
  } else if (entry.kind === "pi.reset") {
    items.push({ kind: "notice", text: "Context reset" })
  }
  const stamped = items.map((item) => ({ ...item, entryId: entry.id }))
  ITEM_CACHE.set(entry, stamped)
  return stamped
}

export function itemsOf(entries: readonly EntryView[]): readonly EntryItem[] {
  return entries.flatMap(entryItems)
}

export type ItemContext = {
  readonly threads: readonly ThreadSummary[]
  readonly requests: readonly RequestRow[]
  readonly onOpenThread: (id: number) => void
  readonly onAnswer: (request: RequestRow, answer: string) => Promise<void>
  readonly onRetry: (entryId: number) => Promise<void>
}

export function OwnerBubble(props: {
  text: string
  attachments?: readonly Attachment[] | undefined
  density: "chat" | "panel"
}): JSX.Element {
  const files = (): readonly Attachment[] => props.attachments ?? []
  return (
    <div class="flex flex-col items-end gap-1.5">
      <Show when={files().length > 0}>
        <div class="w-full" classList={{ "max-w-[520px]": props.density === "chat", "max-w-[280px]": props.density === "panel" }}>
          <SentAttachments attachments={files()} />
        </div>
      </Show>
      <Show when={props.text !== ""}>
        <div
          class="rounded-md border border-line-2 bg-secondary py-2.5 text-base leading-[1.6] text-ink"
          classList={{ "max-w-[520px] px-3.5": props.density === "chat", "max-w-[280px] px-3": props.density === "panel" }}
        >
          <span class="whitespace-pre-wrap [overflow-wrap:anywhere]">{props.text}</span>
        </div>
      </Show>
    </div>
  )
}

function QuestionItem(props: {
  row: BatchRow
  threads: readonly ThreadSummary[]
  requests: readonly RequestRow[]
  onOpenThread: (id: number) => void
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
}): JSX.Element {
  const request = (): RequestRow | undefined => {
    const threadId = Number(props.row.threadId)
    return props.requests.find(
      (candidate) => candidate.conversationId === threadId && candidate.question === props.row.text,
    )
  }
  const thread = (): ThreadSummary | undefined =>
    props.threads.find((candidate) => String(candidate.id) === props.row.threadId)
  return (
    <Show
      when={request()}
      fallback={<QuestionInboundCard row={props.row} thread={thread()} onOpenThread={props.onOpenThread} />}
    >
      {(found) => (
        <OpenQuestionCard
          title={props.row.title}
          request={found()}
          onAnswer={(_requestId, answer) => props.onAnswer(found(), answer)}
        />
      )}
    </Show>
  )
}

/** A card the timeline passes through: a thread's report, question or job, a failed turn, or a notice. */
export function EntryCard(props: { item: PassItem; context: ItemContext }): JSX.Element {
  const item = props.item
  switch (item.kind) {
    case "report":
      return <ReportCard row={item.row} onOpenThread={props.context.onOpenThread} />
    case "question":
      return (
        <QuestionItem
          row={item.row}
          threads={props.context.threads}
          requests={props.context.requests}
          onOpenThread={props.context.onOpenThread}
          onAnswer={props.context.onAnswer}
        />
      )
    case "job":
      return <JobCard row={item.row} onOpenThread={props.context.onOpenThread} />
    case "failure":
      return <FailureCard failure={item.failure} onRetry={() => props.context.onRetry(item.entryId)} />
    case "notice":
      return <SystemNotice text={item.text} />
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}
