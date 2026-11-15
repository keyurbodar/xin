import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { visualState } from "../../lib/status.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { parseHistoryPage, type AnsweredView, type EntryView, type RequestRow, type Snapshot } from "../../state/conversation.ts"
import { openRequests, respondToQuestion } from "../../state/requests.ts"
import { Loading, ThreadSkeleton } from "../ui/skeleton.tsx"
import { Transcript } from "./transcript.tsx"
import { SteerComposer } from "./composer.tsx"
import { OpenQuestionCard } from "./cards.tsx"

/** A thread tab: the thread's own transcript in the centre column, with the steer composer under it. */
export function ThreadConversation(props: {
  project: ProjectSummary
  thread: ThreadSummary
  snapshot: Snapshot | undefined
  onOpenThread: (id: number) => void
}): JSX.Element {
  const [answered, setAnswered] = createSignal<readonly AnsweredView[]>([])
  const [older, setOlder] = createSignal<readonly EntryView[]>([])
  const [olderBefore, setOlderBefore] = createSignal<number | undefined>(undefined)
  const [olderDone, setOlderDone] = createSignal(false)
  const state = () => visualState(props.thread.status)
  const busy = (): boolean => state() === "working"
  const requests = (): readonly RequestRow[] =>
    openRequests().filter((request) => request.conversationId === props.thread.id)

  createEffect(() => {
    void props.thread.id
    setAnswered([])
    setOlder([])
    setOlderBefore(undefined)
    setOlderDone(false)
  })

  const answer = async (request: RequestRow, text: string): Promise<void> => {
    await respondToQuestion(request, text)
    setAnswered((current) => [
      ...current,
      { conversationId: request.conversationId, question: request.question, answer: text, answeredAt: Date.now() },
    ])
  }

  const loadOlder = async (): Promise<void> => {
    const before = olderBefore() ?? props.snapshot?.before
    if (before === undefined) return
    const page = parseHistoryPage(
      await cmd<unknown>("history.page", { conversationId: props.thread.id, before, limit: 60 }),
    )
    setOlder((current) => [...page.entries, ...current])
    if (page.entries.length === 0 || page.nextBefore === undefined) setOlderDone(true)
    else setOlderBefore(page.nextBefore)
  }

  const hasOlder = (): boolean =>
    props.snapshot !== undefined && !olderDone() && (olderBefore() !== undefined || props.snapshot.before !== undefined)

  return (
    <div class="flex min-h-0 flex-1 flex-col [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-1 [&>div:first-child]:flex-col">
      <Loading when={props.snapshot === undefined} skeleton={<ThreadSkeleton />} label="Loading thread">
        <Show when={props.snapshot}>
          {(value) => (
            <Transcript
              snapshot={value()}
              project={props.project}
              optimistic={[]}
              older={older()}
              hasOlder={hasOlder()}
              requests={requests()}
              answered={answered()}
              onOpenThread={props.onOpenThread}
              onAnswer={answer}
              onRetry={async (entryId) => {
                await cmd("message.retry", { entryId })
              }}
              onLoadOlder={loadOlder}
            />
          )}
        </Show>
      </Loading>
      <div class="mx-auto w-full max-w-[var(--w-column)]">
        <For each={requests()}>
          {(request) => (
            <div class="px-3 pt-3">
              <OpenQuestionCard
                title={props.thread.title}
                request={request}
                onAnswer={async (_requestId, text) => {
                  await answer(request, text)
                }}
              />
            </div>
          )}
        </For>
        <SteerComposer
          threadTitle={props.thread.title}
          busy={busy()}
          waiting={state() === "needs"}
          onSend={async (text) => {
            await cmd("thread.send", { threadId: props.thread.id, text, mode: busy() ? "steer" : "queue" })
          }}
          onStop={async () => {
            await cmd("thread.stop", { threadId: props.thread.id })
          }}
        />
      </div>
    </div>
  )
}
