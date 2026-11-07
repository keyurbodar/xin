import { For, Show, createEffect, onMount, type JSX } from "solid-js"
import {
  entryBatchRows,
  entryFailure,
  entryText,
  entryToolCalls,
  liveOf,
  type AnsweredView,
  type BatchRow,
  type EntryView,
  type FailureData,
  type RequestRow,
  type Snapshot,
  type ToolCallView,
} from "../../state/conversation.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { Icon } from "../ui/icon.tsx"
import { Markdown } from "./markdown.tsx"
import {
  AnsweredQuestionCard,
  FailureCard,
  JobCard,
  OpenQuestionCard,
  QuestionInboundCard,
  ReportCard,
  SystemNotice,
  ThreadFan,
} from "./cards.tsx"
import { projectIcon } from "../../lib/project-icon.ts"
import { ProjectGlyph } from "./project-glyph.tsx"

export type PendingMessage = {
  readonly key: string
  readonly text: string
  readonly at: number
}

type Item =
  | { readonly kind: "owner"; readonly text: string }
  | {
      readonly kind: "assistant"
      readonly text: string
      readonly calls: readonly ToolCallView[]
    }
  | { readonly kind: "report"; readonly row: BatchRow }
  | { readonly kind: "question"; readonly row: BatchRow }
  | { readonly kind: "job"; readonly row: BatchRow }
  | { readonly kind: "failure"; readonly entryId: number; readonly failure: FailureData }
  | { readonly kind: "notice"; readonly text: string }

/** One entry becomes one stable group of items, cached by the entry view `For` keys on. */
const ITEM_CACHE = new WeakMap<EntryView, readonly Item[]>()

function entryItems(entry: EntryView): readonly Item[] {
  const cached = ITEM_CACHE.get(entry)
  if (cached !== undefined) return cached
  const items: Item[] = []
  if (entry.kind === "xin.batch") {
    for (const row of entryBatchRows(entry)) {
      switch (row.kind) {
        case "user":
          if (row.text.trim() !== "") items.push({ kind: "owner", text: row.text })
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
    if (text !== "") items.push({ kind: "owner", text })
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

function itemsOf(entries: readonly EntryView[]): readonly Item[] {
  return entries.flatMap(entryItems)
}

function threadsOf(project: ProjectSummary): readonly ThreadSummary[] {
  const groups = project.threads
  return [...groups.working, ...groups.waiting, ...groups.completed, ...groups.failed, ...groups.cancelled]
}

function OwnerBubble(props: { text: string }): JSX.Element {
  return (
    <div class="flex justify-end">
      <div class="max-w-[520px] rounded-[4px] border border-line-inner bg-hover px-3.5 py-2.5 text-[14px] leading-[1.6] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
        {props.text}
      </div>
    </div>
  )
}

function CoordinatorMeta(props: { busy?: boolean | undefined }): JSX.Element {
  return (
    <div class="font-mono text-[11px] leading-none text-fg-4">
      <span classList={{ shimmer: props.busy === true }}>{props.busy === true ? "Coordinator · working" : "Coordinator"}</span>
    </div>
  )
}

function Welcome(props: { project: ProjectSummary }): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <span class="grid h-10 w-10 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-2">
        <Icon name={projectIcon(props.project.slug)} size={18} />
      </span>
      <div class="flex flex-col gap-1.5">
        <span class="text-[15px] font-medium text-fg">Start the conversation</span>
        <span class="max-w-[360px] text-[13px] leading-[1.6] text-fg-3">
          {props.project.goal ?? "Tell the coordinator what you want done. It can fan work out into threads and report back here."}
        </span>
      </div>
    </div>
  )
}

function QuestionItem(props: {
  row: BatchRow
  requests: readonly RequestRow[]
  onOpenThread: (id: number) => void
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
}): JSX.Element {
  const request = (): RequestRow | undefined => {
    const threadId = Number(props.row.threadId)
    return props.requests.find((candidate) => candidate.conversationId === threadId && candidate.question === props.row.text)
  }
  return (
    <Show
      when={request()}
      fallback={<QuestionInboundCard row={props.row} onOpenThread={props.onOpenThread} />}
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

export function Transcript(props: {
  snapshot: Snapshot
  project: ProjectSummary
  optimistic: readonly PendingMessage[]
  requests: readonly RequestRow[]
  answered: readonly AnsweredView[]
  onOpenThread: (id: number) => void
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
  onRetry: (entryId: number) => Promise<void>
}): JSX.Element {
  let scroller!: HTMLDivElement
  let pinned = true

  const items = (): readonly Item[] => itemsOf(props.snapshot.entries)
  const live = () => liveOf(props.snapshot)

  const stick = (): void => {
    if (!pinned || scroller === undefined) return
    queueMicrotask(() => {
      scroller.scrollTop = scroller.scrollHeight
    })
  }

  onMount(() => {
    stick()
  })

  createEffect(() => {
    items()
    live().partial
    live().busy
    props.optimistic.length
    props.answered.length
    stick()
  })

  return (
    <div
      ref={scroller}
      onScroll={() => {
        pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96
      }}
      class="min-h-0 flex-1 overflow-y-auto"
    >
      <div class="mx-auto flex w-full max-w-[760px] flex-col gap-[18px] px-6 pb-6 pt-7">
        <Show when={props.snapshot.before !== undefined}>
          <div class="text-center font-mono text-[10.5px] text-fg-4">
            Earlier messages aren’t loaded · showing recent history
          </div>
        </Show>

        <Show when={items().length === 0 && props.optimistic.length === 0 && !live().busy}>
          <Welcome project={props.project} />
        </Show>

        <For each={items()}>
          {(value) => {
            switch (value.kind) {
              case "owner":
                return <OwnerBubble text={value.text} />
              case "assistant":
                return (
                  <div class="flex gap-3">
                    <ProjectGlyph slug={props.project.slug} class="mt-0.5" />
                    <div class="flex min-w-0 flex-1 flex-col gap-3">
                      <CoordinatorMeta />
                      <Show when={value.text !== ""}>
                        <Markdown text={value.text} />
                      </Show>
                      <Show when={value.calls.length > 0}>
                        <ThreadFan calls={value.calls} threads={threadsOf(props.project)} onOpenThread={props.onOpenThread} />
                      </Show>
                    </div>
                  </div>
                )
              case "report":
                return (
                  <div class="flex gap-3">
                    <ProjectGlyph slug={props.project.slug} class="mt-0.5" />
                    <div class="min-w-0 flex-1">
                      <ReportCard row={value.row} onOpenThread={props.onOpenThread} />
                    </div>
                  </div>
                )
              case "question":
                return (
                  <div class="flex gap-3">
                    <ProjectGlyph slug={props.project.slug} class="mt-0.5" />
                    <div class="min-w-0 flex-1">
                      <QuestionItem
                        row={value.row}
                        requests={props.requests}
                        onOpenThread={props.onOpenThread}
                        onAnswer={props.onAnswer}
                      />
                    </div>
                  </div>
                )
              case "job":
                return (
                  <div class="flex gap-3">
                    <ProjectGlyph slug={props.project.slug} class="mt-0.5" />
                    <div class="min-w-0 flex-1">
                      <JobCard row={value.row} onOpenThread={props.onOpenThread} />
                    </div>
                  </div>
                )
              case "failure":
                return (
                  <FailureCard
                    failure={value.failure}
                    onRetry={() => props.onRetry(value.entryId)}
                  />
                )
              case "notice":
                return <SystemNotice text={value.text} />
              default: {
                const _exhaustive: never = value
                return _exhaustive
              }
            }
          }}
        </For>

        <For each={props.answered}>
          {(item) => (
            <div class="flex gap-3">
              <ProjectGlyph slug={props.project.slug} class="mt-0.5" />
              <div class="min-w-0 flex-1">
                <AnsweredQuestionCard
                  question={item.question}
                  answer={item.answer}
                  answeredAt={item.answeredAt}
                />
              </div>
            </div>
          )}
        </For>

        <Show when={live().busy}>
          <div class="flex gap-3">
            <ProjectGlyph slug={props.project.slug} class="mt-0.5" />
            <div class="flex min-w-0 flex-1 flex-col gap-3">
              <CoordinatorMeta busy />
              <Show
                when={live().partial !== ""}
                fallback={
                  <div class="text-[13px] text-fg-3">
                    <span class="shimmer">
                      {live().tools.at(-1)?.name === undefined ? "Thinking" : `Running ${live().tools.at(-1)?.name}`}
                    </span>
                  </div>
                }
              >
                <div class="flex min-w-0 flex-1 items-start gap-1">
                  <div class="min-w-0 flex-1">
                    <Markdown text={live().partial} />
                  </div>
                  <span class="mt-1.5 inline-block h-4 w-px shrink-0 animate-pulse bg-fg" />
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <For each={props.optimistic}>
          {(message) => <OwnerBubble text={message.text} />}
        </For>
      </div>
    </div>
  )
}

/** The transcript's loading shape, drawn over by Skullet until the first snapshot lands. */
export function TranscriptSkeleton(): JSX.Element {
  return (
    <div class="mx-auto flex w-full max-w-[760px] flex-col gap-[18px] px-6 pb-6 pt-7">
      <div class="flex justify-end">
        <div class="h-11 w-[340px] rounded-[4px] border border-line-inner bg-hover" />
      </div>
      <div class="flex gap-3">
        <span class="h-6 w-6 shrink-0 rounded-[2px] border border-line-inner bg-raised" />
        <div class="flex flex-1 flex-col gap-2.5">
          <span class="h-2.5 w-24 rounded-[1px] bg-hover" />
          <span class="h-3 w-[86%] rounded-[1px] bg-hover" />
          <span class="h-3 w-[72%] rounded-[1px] bg-hover" />
          <span class="h-3 w-[48%] rounded-[1px] bg-hover" />
        </div>
      </div>
      <div class="flex gap-3">
        <span class="h-6 w-6 shrink-0 rounded-[2px] border border-line-inner bg-raised" />
        <div class="flex flex-1 flex-col gap-2.5">
          <span class="h-16 w-full rounded-[4px] border border-line-inner bg-raised" />
        </div>
      </div>
    </div>
  )
}
