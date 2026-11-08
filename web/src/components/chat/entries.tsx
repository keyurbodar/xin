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
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { FileChip } from "../ui/file-chip.tsx"
import { Markdown } from "./markdown.tsx"
import {
  FailureCard,
  JobCard,
  OpenQuestionCard,
  QuestionInboundCard,
  ReportCard,
  SystemNotice,
  ThreadFan,
} from "./cards.tsx"

export type EntryItem =
  | { readonly kind: "owner"; readonly text: string; readonly attachments: readonly Attachment[] }
  | { readonly kind: "assistant"; readonly text: string; readonly calls: readonly ToolCallView[] }
  | { readonly kind: "report"; readonly row: BatchRow }
  | { readonly kind: "question"; readonly row: BatchRow }
  | { readonly kind: "job"; readonly row: BatchRow }
  | { readonly kind: "failure"; readonly entryId: number; readonly failure: FailureData }
  | { readonly kind: "notice"; readonly text: string }

/** One entry becomes one stable group of items, cached by the entry view `For` keys on. */
const ITEM_CACHE = new WeakMap<EntryView, readonly EntryItem[]>()

export function entryItems(entry: EntryView): readonly EntryItem[] {
  const cached = ITEM_CACHE.get(entry)
  if (cached !== undefined) return cached
  const items: EntryItem[] = []
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
    const calls = entryToolCalls(entry).filter((call) => call.name === "delegate_task")
    if (text !== "" || calls.length > 0) items.push({ kind: "assistant", text, calls })
  } else if (entry.kind === "pi.reset") {
    items.push({ kind: "notice", text: "Context reset" })
  }
  ITEM_CACHE.set(entry, items)
  return items
}

export function itemsOf(entries: readonly EntryView[]): readonly EntryItem[] {
  return entries.flatMap(entryItems)
}

export type ItemContext = {
  readonly project: ProjectSummary | undefined
  readonly threads: readonly ThreadSummary[]
  readonly links: ReadonlyMap<string, number>
  readonly requests: readonly RequestRow[]
  readonly density: "chat" | "panel"
  readonly onOpenThread: (id: number) => void
  readonly onAnswer: (request: RequestRow, answer: string) => Promise<void>
  readonly onRetry: (entryId: number) => Promise<void>
}

const NO_LINKS: ReadonlyMap<string, number> = new Map()

export function OwnerBubble(props: {
  text: string
  attachments?: readonly Attachment[] | undefined
  density: "chat" | "panel"
}): JSX.Element {
  const files = (): readonly Attachment[] => props.attachments ?? []
  return (
    <div class="flex flex-col items-end gap-1.5">
      <Show when={files().length > 0}>
        <div class="flex flex-wrap justify-end gap-1.5">
          <For each={files()}>{(file) => <FileChip name={file.name} type={file.type} size={file.size} />}</For>
        </div>
      </Show>
      <Show when={props.text !== ""}>
        <div
          class="rounded-[18px] bg-fill text-[15px] leading-[24px] text-fg"
          classList={{ "max-w-[520px] px-4 py-3": props.density === "chat", "max-w-[280px] px-3 py-2.5": props.density === "panel" }}
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

/** One item of a transcript, shared by the project chat and a thread's own body. */
export function EntryItemView(props: { item: EntryItem; context: ItemContext }): JSX.Element {
  const fan = (calls: readonly ToolCallView[]): JSX.Element => (
    <ThreadFan
      calls={calls}
      threads={props.context.threads}
      links={props.context.links ?? NO_LINKS}
      onOpenThread={props.context.onOpenThread}
    />
  )

  const item = props.item
  switch (item.kind) {
    case "owner":
      return <OwnerBubble text={item.text} attachments={item.attachments} density={props.context.density} />
    case "assistant":
      return (
        <div class="flex min-w-0 flex-col gap-3">
          <Show when={item.text !== ""}>
            <Markdown size={props.context.density === "panel" ? "small" : "body"} text={item.text} />
          </Show>
          <Show when={item.calls.length > 0}>{fan(item.calls)}</Show>
        </div>
      )
    case "report":
      return (
        <div class="min-w-0">
          <ReportCard row={item.row} onOpenThread={props.context.onOpenThread} />
        </div>
      )
    case "question":
      return (
        <div class="min-w-0">
          <QuestionItem
            row={item.row}
            threads={props.context.threads}
            requests={props.context.requests}
            onOpenThread={props.context.onOpenThread}
            onAnswer={props.context.onAnswer}
          />
        </div>
      )
    case "job":
      return (
        <div class="min-w-0">
          <JobCard row={item.row} onOpenThread={props.context.onOpenThread} />
        </div>
      )
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

export function EntryList(props: { items: readonly EntryItem[]; context: ItemContext }): JSX.Element {
  return (
    <For each={props.items}>{(item) => <EntryItemView item={item} context={props.context} />}</For>
  )
}
