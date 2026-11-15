import { createResource, For, Show, type JSX } from "solid-js"
import { firstLoad } from "../../lib/loading.ts"
import { Clock } from "lucide-solid"
import { cmd } from "../../lib/api.ts"
import { drive, type DriveListing } from "../../lib/drive.ts"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { STATE_WORD, visualState, type SignalState } from "../../lib/status.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import { Signal } from "../ui/signal.tsx"
import { Loading, PaneSkeleton, RowSkeleton } from "../ui/skeleton.tsx"
import { EmptyState, ResourceError } from "../chat/ui.tsx"

const FILES_FRESH_MS = 60_000
const listed = new Map<string, { readonly at: number; readonly listing: Promise<DriveListing> }>()

export function projectFiles(slug: string): Promise<DriveListing> {
  const listing = drive.list({ kind: "project", id: slug }, "").then((found) => ({
    ...found,
    files: found.files.toSorted((left, right) => right.updated_at - left.updated_at),
  }))
  listed.set(slug, { at: Date.now(), listing })
  listing.catch(() => listed.delete(slug))
  return listing
}

export function forgetProjectFiles(slug: string): void {
  listed.delete(slug)
}

export function recentProjectFiles(slug: string): Promise<DriveListing> {
  const cached = listed.get(slug)
  return cached !== undefined && Date.now() - cached.at < FILES_FRESH_MS ? cached.listing : projectFiles(slug)
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

export function openFile(slug: string, path: string): void {
  navigate(`/p/${slug}/files/${encodeURIComponent(path)}`)
}

export const PANE_ROW =
  "im-hover flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left"

type JobEntry = {
  readonly id: number
  readonly tool: string
  readonly title: string
  readonly startedAt: number
  readonly deadlineAt: number
  readonly state: "running" | "completed" | "failed"
  readonly result?: string
}

function jobState(state: JobEntry["state"]): SignalState {
  switch (state) {
    case "running":
      return "working"
    case "failed":
      return "failed"
    case "completed":
      return "done"
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

export function JobsView(): JSX.Element {
  const [jobs, { refetch }] = createResource(() => cmd<{ readonly jobs: readonly JobEntry[] }>("job.list", {}))
  return (
    <Loading when={firstLoad(jobs)} skeleton={<RowSkeleton rows={4} />} label="Loading jobs">
      <Show when={jobs.error}>
        <ResourceError what="jobs" error={jobs.error} onRetry={() => void refetch()} />
      </Show>
      <Show when={jobs()}>
        {(data) => (
          <Show
            when={data().jobs.length > 0}
            fallback={<EmptyState pictogram="jobs" title="No jobs" detail="A job runs one long tool call in the background and reports back here." />}
          >
            <For each={data().jobs}>
              {(job) => (
                <div class="flex items-start gap-2.5 rounded-sm px-2 py-1.5">
                  <Signal state={jobState(job.state)} size={16} class="mt-0.5 shrink-0" />
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-sm text-ink">{job.title}</span>
                    <span class="flex items-center gap-1.5 text-xs text-ink-3">
                      <Clock size={12} stroke-width={1.5} />
                      <span class="truncate">{job.tool}</span>
                      <span>· {job.state}</span>
                    </span>
                    <Show when={job.result}>
                      {(text) => <span class="line-clamp-3 text-xs text-ink-2">{text()}</span>}
                    </Show>
                  </span>
                  <span class="shrink-0 font-mono text-2xs text-ink-3">{ago(job.startedAt)}</span>
                </div>
              )}
            </For>
          </Show>
        )}
      </Show>
    </Loading>
  )
}

export function ThreadLine(props: { thread: ThreadSummary; onOpen: (id: number) => void }): JSX.Element {
  const state = (): SignalState => visualState(props.thread.status)
  return (
    <button type="button" onClick={() => props.onOpen(props.thread.id)} class={PANE_ROW}>
      <Signal state={state()} size={16} class="mt-0.5 shrink-0" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-ink">{props.thread.title}</span>
        <span class="block truncate text-xs text-ink-3" classList={{ "im-shimmer": state() === "working" }}>
          {props.thread.statusLine ?? STATE_WORD[state()]}
        </span>
      </span>
      <span class="shrink-0 font-mono text-2xs text-ink-3">{ago(props.thread.beatAt)}</span>
    </button>
  )
}

const GROUPS = [
  { key: "waiting", label: "Waiting on you" },
  { key: "working", label: "Working" },
  { key: "failed", label: "Failed" },
  { key: "completed", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
] as const

export function ThreadsView(props: { project: ProjectSummary; onOpenThread: (id: number) => void }): JSX.Element {
  const total = (): number => GROUPS.reduce((sum, group) => sum + props.project.threads[group.key].length, 0)
  return (
    <Show
      when={total() > 0}
      fallback={<EmptyState pictogram="threads" title="No threads yet" detail="Ask the coordinator to start one; it appears here and in the chat." />}
    >
      <For each={GROUPS.filter((group) => props.project.threads[group.key].length > 0)}>
        {(group) => (
          <section class="flex flex-col pb-2">
            <span class="px-2 pb-1 pt-1 text-xs text-ink-3">
              {group.label} <span class="font-mono text-icon">{props.project.threads[group.key].length}</span>
            </span>
            <For each={props.project.threads[group.key]}>
              {(thread) => <ThreadLine thread={thread} onOpen={props.onOpenThread} />}
            </For>
          </section>
        )}
      </For>
    </Show>
  )
}
