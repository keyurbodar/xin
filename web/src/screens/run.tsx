import { Show, type JSX } from "solid-js"
import { connect } from "../state/connection.ts"
import { createConversationView } from "../state/conversation.ts"
import type { ProjectSummary } from "../state/home.ts"
import { navigate } from "../lib/router.ts"
import { Transcript, TranscriptSkeleton } from "../components/chat/transcript.tsx"
import { Skullet } from "../components/ui/skeleton.tsx"

/** A schedule's delivered run, read-only: the transcript the timer produced. */
export function RunScreen(props: { project: ProjectSummary; conversationId: number; label?: string | undefined }): JSX.Element {
  const streams = connect()
  const snapshot = createConversationView(streams, () => props.conversationId)
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <button type="button" class="link truncate text-[13.5px]" onClick={() => navigate(`/p/${props.project.slug}`)}>
          {props.project.name}
        </button>
        <span class="text-fg-4">/</span>
        <span class="text-[13.5px] text-fg-3">Scheduled run</span>
        <Show when={props.label}>
          {(label) => <span class="ml-auto shrink-0 font-mono text-[11px] text-fg-4">{label()}</span>}
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Skullet loading={snapshot() === undefined} sample={() => <TranscriptSkeleton />} label="Loading run">
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
        </Skullet>
      </div>
    </div>
  )
}
