import { Show, type JSX } from "solid-js"
import { connect } from "../state/connection.ts"
import { createConversationView } from "../state/conversation.ts"
import type { ProjectSummary } from "../state/home.ts"
import { navigate } from "../lib/router.ts"
import { Transcript } from "../components/chat/transcript.tsx"
import { Loading, ThreadSkeleton } from "../components/ui/skeleton.tsx"

/** A schedule's delivered run, read-only: the transcript the timer produced. */
export function RunScreen(props: { project: ProjectSummary; conversationId: number; label?: string | undefined }): JSX.Element {
  const streams = connect()
  const snapshot = createConversationView(streams, () => props.conversationId)
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line-1 px-4">
        <button type="button" class="link truncate text-base" onClick={() => navigate(`/p/${props.project.slug}`)}>
          {props.project.name}
        </button>
        <span class="text-icon">/</span>
        <span class="text-base text-ink-3">Scheduled run</span>
        <Show when={props.label}>
          {(label) => <span class="ml-auto shrink-0 font-mono text-2xs text-icon">{label()}</span>}
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Loading when={snapshot() === undefined} skeleton={<ThreadSkeleton />} label="Loading run">
          <Show when={snapshot()}>
            {(value) => (
              <Transcript
                snapshot={value()}
                project={props.project}
                optimistic={[]}
                older={[]}
                hasOlder={false}
                requests={[]}
                answered={[]}
                onOpenThread={() => undefined}
                onAnswer={async () => undefined}
                onRetry={async () => undefined}
                onLoadOlder={async () => undefined}
              />
            )}
          </Show>
        </Loading>
      </div>
    </div>
  )
}
