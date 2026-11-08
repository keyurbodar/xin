import { For, Show, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js"
import {
  delegatedThreads,
  liveOf,
  type AnsweredView,
  type Attachment,
  type EntryView,
  type RequestRow,
  type Snapshot,
} from "../../state/conversation.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { Icon } from "../ui/icon.tsx"
import { Markdown } from "./markdown.tsx"
import { AnsweredQuestionCard } from "./cards.tsx"
import { EntryList, OwnerBubble, itemsOf, type EntryItem, type ItemContext } from "./entries.tsx"
import { projectIcon } from "../../lib/project-icon.ts"
import { ProjectGlyph } from "./project-glyph.tsx"

export type PendingMessage = {
  readonly key: string
  readonly text: string
  readonly at: number
  readonly attachments: readonly Attachment[]
}

function threadsOf(project: ProjectSummary): readonly ThreadSummary[] {
  const groups = project.threads
  return [...groups.working, ...groups.waiting, ...groups.completed, ...groups.failed, ...groups.cancelled]
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

export function Transcript(props: {
  snapshot: Snapshot
  project: ProjectSummary
  optimistic: readonly PendingMessage[]
  older: readonly EntryView[]
  hasOlder: boolean
  requests: readonly RequestRow[]
  answered: readonly AnsweredView[]
  onOpenThread: (id: number) => void
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
  onRetry: (entryId: number) => Promise<void>
  onLoadOlder: () => Promise<void>
}): JSX.Element {
  let scroller!: HTMLDivElement
  let pinned = true
  const [loadingOlder, setLoadingOlder] = createSignal(false)

  const items = (): readonly EntryItem[] => itemsOf([...props.older, ...props.snapshot.entries])
  const links = createMemo(() => delegatedThreads([...props.older, ...props.snapshot.entries]))
  const context = createMemo<ItemContext>(() => ({
    project: props.project,
    threads: threadsOf(props.project),
    links: links(),
    requests: props.requests,
    density: "chat",
    onOpenThread: props.onOpenThread,
    onAnswer: props.onAnswer,
    onRetry: props.onRetry,
  }))
  const live = () => liveOf(props.snapshot)

  const loadOlder = async (): Promise<void> => {
    if (loadingOlder()) return
    setLoadingOlder(true)
    const height = scroller.scrollHeight
    try {
      await props.onLoadOlder()
      requestAnimationFrame(() => {
        scroller.scrollTop += scroller.scrollHeight - height
      })
    } finally {
      setLoadingOlder(false)
    }
  }

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
      <div class="mx-auto flex w-full max-w-[720px] flex-col gap-[18px] px-6 pb-6 pt-7">
        <Show when={props.hasOlder}>
          <div class="flex flex-col items-center gap-2 pb-1">
            <button
              type="button"
              disabled={loadingOlder()}
              onClick={() => void loadOlder()}
              class="rounded-[2px] border border-line-inner px-2.5 py-1 text-[12px] text-fg-2 transition-colors hover:border-line-strong hover:bg-hover disabled:text-fg-4"
            >
              {loadingOlder() ? "Loading" : "Load older messages"}
            </button>
            <span class="font-mono text-[10.5px] text-fg-4">showing recent history</span>
          </div>
        </Show>

        <Show when={items().length === 0 && props.optimistic.length === 0 && !live().busy}>
          <Welcome project={props.project} />
        </Show>

        <EntryList items={items()} context={context()} />

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
          {(message) => <OwnerBubble text={message.text} attachments={message.attachments} density="chat" />}
        </For>
      </div>
    </div>
  )
}

export function TranscriptSkeleton(): JSX.Element {
  return (
    <div class="mx-auto flex w-full max-w-[720px] flex-col gap-[18px] px-6 pb-6 pt-7">
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
