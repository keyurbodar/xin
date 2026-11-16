import { For, Show, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js"
import {
  delegatedThreads,
  liveOf,
  toolResultsOf,
  type AnsweredView,
  type Attachment,
  type EntryView,
  type RequestRow,
  type Snapshot,
} from "../../state/conversation.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { Icon } from "../ui/icon.tsx"
import { Thinking } from "../ui/loaders.tsx"
import { Markdown } from "./markdown.tsx"
import { AnsweredQuestionCard } from "./cards.tsx"
import { EntryList, OwnerBubble, itemsOf, type EntryItem, type ItemContext } from "./entries.tsx"
import { ProjectGlyph } from "./project-glyph.tsx"
import { bindConversation } from "../../plugins/slots.tsx"

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
    <div class="font-mono text-2xs leading-none text-icon">
      <span classList={{ "im-shimmer": props.busy === true }}>{props.busy === true ? "Coordinator · working" : "Coordinator"}</span>
    </div>
  )
}

function Welcome(props: { project: ProjectSummary }): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <ProjectGlyph slug={props.project.slug} name={props.project.name} goal={props.project.goal} size={40} />
      <div class="flex flex-col gap-1.5">
        <span class="text-[15px] font-medium text-ink">Start the conversation</span>
        <span class="max-w-[360px] text-base leading-[1.6] text-ink-3">
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

  const entries = createMemo(() => [...props.older, ...props.snapshot.entries])
  const items = (): readonly EntryItem[] => itemsOf(entries())
  const links = createMemo(() => delegatedThreads(entries()))
  const results = createMemo(() => toolResultsOf(entries()))
  bindConversation(() => (props.snapshot.id === undefined ? undefined : { id: props.snapshot.id, entries: entries() }))
  const context = createMemo<ItemContext>(() => ({
    project: props.project,
    threads: threadsOf(props.project),
    links: links(),
    results: results(),
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
              class="rounded-sm border border-line-2 px-2.5 py-1 text-sm text-ink-2 hover:border-line-3 hover:bg-secondary disabled:text-icon"
            >
              {loadingOlder() ? "Loading" : "Load older messages"}
            </button>
            <span class="font-mono text-2xs text-icon">showing recent history</span>
          </div>
        </Show>

        <Show when={items().length === 0 && props.optimistic.length === 0 && !live().busy}>
          <Welcome project={props.project} />
        </Show>

        <EntryList items={items()} context={context()} />

        <For each={props.answered}>
          {(item) => (
            <div class="flex gap-3">
              <ProjectGlyph slug={props.project.slug} name={props.project.name} goal={props.project.goal} class="mt-0.5" />
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
            <ProjectGlyph slug={props.project.slug} name={props.project.name} goal={props.project.goal} class="mt-0.5" />
            <div class="flex min-w-0 flex-1 flex-col gap-3">
              <CoordinatorMeta busy />
              <Show
                when={live().partial !== ""}
                fallback={
                  <div class="text-base text-ink-3">
                    <Show when={live().tools.at(-1)?.name} fallback={<Thinking>Thinking</Thinking>}>
                      {(name) => <span class="im-shimmer">Running {name()}</span>}
                    </Show>
                  </div>
                }
              >
                <div class="flex min-w-0 flex-1 items-start gap-1">
                  <div class="min-w-0 flex-1">
                    <Markdown streaming text={live().partial} />
                  </div>
                  <span class="im-caret mt-1.5 shrink-0" />
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
