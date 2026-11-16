import { MessagesSquare } from "lucide-solid"
import { For, Show, createMemo, type JSX } from "solid-js"
import { visualState } from "../../lib/status.ts"
import { bindConversation, rendererFor, ToolRenderer } from "../../plugins/slots.tsx"
import { numOf } from "../../lib/parse.ts"
import {
  delegatedThreads,
  entryToolCalls,
  type AnsweredView,
  type Attachment,
  type EntryView,
  type RequestRow,
  type Snapshot,
} from "../../state/conversation.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { SentBlobsScope } from "../composer/attachment-card.tsx"
import { ChipFace } from "../ui/chip-face.tsx"
import { lazyView } from "../ui/lazy-view.tsx"
import type { LinkChipProps } from "../ui/link-chip.tsx"
import { Thinking } from "../ui/loaders.tsx"
import { hasBlock, renderBlock } from "./blocks.tsx"
import { AnsweredQuestionCard, ThreadFan } from "./cards.tsx"
import { EntryCard, type ItemContext } from "./entries.tsx"
import { ProjectGlyph } from "./project-glyph.tsx"
import type { RenderLink } from "./timeline/dividers.tsx"
import { buildTimeline, liveTimelineOf, waitTarget, type TimelineItem, type TimelineLink, type ToolCall } from "./timeline/model.ts"
import { Timeline } from "./timeline/timeline.tsx"

const ThreadChip = lazyView<Extract<LinkChipProps, { kind: "thread" }>>(
  () => import("../ui/link-chip.tsx").then((module) => module.LinkChip),
  (props) => <ChipFace href={props.href} kind={props.kind} label={props.label} tone="text-ink-3" icon={MessagesSquare} mono={false} />,
)

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

const shownAsBlock = (name: string): boolean =>
  name === "delegate_task" || hasBlock(`tool:${name}`) || rendererFor(name) !== undefined

function Welcome(props: { project: ProjectSummary }): JSX.Element {
  return (
    <div class="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <ProjectGlyph slug={props.project.slug} name={props.project.name} goal={props.project.goal} size={40} />
      <div class="flex flex-col gap-1.5">
        <span class="text-title-mini font-title text-ink">Start the conversation</span>
        <span class="max-w-[360px] text-body text-ink-3">
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
  welcome?: JSX.Element
}): JSX.Element {
  const entries = createMemo(() => [...props.older, ...props.snapshot.entries])
  bindConversation(() => (props.snapshot.id === undefined ? undefined : { id: props.snapshot.id, entries: entries() }))
  const threads = createMemo(() => threadsOf(props.project))
  const titles = createMemo(() => new Map(threads().map((thread) => [thread.id, thread.title])))
  const links = createMemo(() => delegatedThreads(entries()))
  const live = createMemo(() => liveTimelineOf(props.snapshot))
  const items = createMemo((): readonly TimelineItem[] => [
    ...buildTimeline(entries(), live(), { hasBlock: shownAsBlock, titles: titles(), now: Date.now() }),
    ...props.optimistic.map((message) => ({
      kind: "owner" as const,
      key: `pending:${message.key}`,
      text: message.text,
      attachments: message.attachments,
    })),
  ])
  const working = createMemo((): readonly TimelineLink[] => {
    const messaged = entries().flatMap((entry) =>
      entryToolCalls(entry).flatMap((call) => {
        const id = call.name === "thread_send" ? numOf(call.arguments.threadId) : undefined
        return id === undefined ? [] : [id]
      }),
    )
    const linked = new Set([...links().values(), ...messaged])
    return threads().flatMap((thread) =>
      thread.status === "working" && linked.has(thread.id) ? [{ threadId: thread.id, label: thread.title }] : [],
    )
  })
  const waiting = createMemo(() =>
    waitTarget({
      live: live(),
      asking: props.requests.some((request) => request.conversationId === props.snapshot.id),
      threads: working(),
    }),
  )
  const thinking = (): boolean => live().busy && live().parts.length === 0 && waiting() === undefined
  const context: ItemContext = {
    get threads() {
      return threads()
    },
    get requests() {
      return props.requests
    },
    onOpenThread: (id) => props.onOpenThread(id),
    onAnswer: (request, answer) => props.onAnswer(request, answer),
    onRetry: (entryId) => props.onRetry(entryId),
  }

  const renderTool = (call: ToolCall): JSX.Element => {
    if (call.name === "delegate_task")
      return (
        <ThreadFan
          calls={[{ id: call.callId, name: call.name, arguments: { ...call.args } }]}
          threads={threads()}
          links={links()}
          onOpenThread={props.onOpenThread}
        />
      )
    const status = call.status === "streaming" ? "running" : call.status
    if (hasBlock(`tool:${call.name}`))
      return renderBlock("tool", {
        name: call.name,
        callId: call.callId,
        args: { ...call.args },
        ...(call.output === undefined ? {} : { output: call.output }),
        status: call.status,
      })
    return <ToolRenderer call={{ name: call.name, args: call.args, output: call.output, details: call.details, status }} />
  }

  const renderLink: RenderLink = (link) => {
    const thread = (): ThreadSummary | undefined => threads().find((candidate) => candidate.id === link.threadId)
    return (
      <ThreadChip
        kind="thread"
        label={link.label}
        href={`#/p/${props.project.slug}/t/${link.threadId}`}
        version={thread()?.status}
        load={async () => ({
          code: `#${link.threadId}`,
          title: thread()?.title ?? link.label,
          project: props.project.name,
          status: visualState(thread()?.status ?? ""),
        })}
      />
    )
  }

  return (
    <SentBlobsScope scope={props.snapshot.id}>
    <Timeline
      items={items()}
      waiting={waiting()}
      hasOlder={props.hasOlder}
      onLoadOlder={props.onLoadOlder}
      renderPass={(item) => <EntryCard item={item} context={context} />}
      renderTool={renderTool}
      renderLink={renderLink}
      header={
        <Show when={items().length === 0 && !live().busy}>
          {props.welcome ?? <Welcome project={props.project} />}
        </Show>
      }
      footer={
        <>
          <For each={props.answered}>
            {(item) => <AnsweredQuestionCard question={item.question} answer={item.answer} answeredAt={item.answeredAt} />}
          </For>
          <Show when={thinking()}>
            <div class="text-body">
              <Thinking>Thinking</Thinking>
            </div>
          </Show>
        </>
      }
    />
    </SentBlobsScope>
  )
}
