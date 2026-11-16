import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { ArrowUpRight, ChevronRight, GitPullRequest, MessageCircleQuestion } from "lucide-solid"
import { ago } from "../../lib/format.ts"
import { keyStarted, stagger } from "../../lib/motion.ts"
import { homeRequests, projectThreads, type ProjectSummary, type ThreadSummary } from "../../state/home.ts"
import { spaceRequests } from "../../lib/spaces.ts"
import type { CaptainProfile } from "../../lib/captains.ts"
import { createOpenIssues } from "../../state/issues.ts"
import { issueScope, threadPulls } from "../../lib/issues.ts"
import { STATE_WORD, visualState } from "../../lib/status.ts"
import { showPaneView } from "../../state/tabs.ts"
import { ICON_BUTTON } from "../shell/menu.ts"
import { Signal } from "../ui/signal.tsx"
import { lazyView } from "../ui/lazy-view.tsx"
import { fileName, PANE_ROW, recentProjectFiles } from "./bodies.tsx"
import { settled } from "../../lib/loading.ts"


/** A Drive file opens as its own pane tab, `file:<path>`, the path inside the project's drive. */
export function fileView(path: string): string {
  return `file:${path}`
}

/** The pane's open issues and, from them, how many pull requests each thread's issues link. */
export function createPaneIssues(context: () => PaneContext): {
  readonly issues: ReturnType<typeof createOpenIssues>
  readonly pullsOf: (thread: number) => number
} {
  const issues = createOpenIssues(() => issueScope(context().project, context().captain))
  const pulls = createMemo(() => threadPulls(issues()?.issues ?? []))
  return { issues, pullsOf: (thread) => pulls().get(thread) ?? 0 }
}

/** The Drive strip loads with its tiles, icons and blob cache, so none of it weighs on the first screen. */
export const DriveSection = lazyView(() => import("./overview-drive.tsx").then((module) => module.DriveSection), () => null)

const OverviewEmpty = lazyView(() => import("./overview-empty.tsx").then((module) => module.OverviewEmpty), () => null)

/** A project pane's Overview, or Kiko's empty state when the project has no requests, threads, issues or files yet. */
export function Overview(props: PaneContext & { children: JSX.Element }): JSX.Element {
  const { issues } = createPaneIssues(() => props)
  const [listing] = createResource(() => props.project.slug, recentProjectFiles)
  const empty = (): boolean =>
    props.captain === undefined &&
    spaceRequests(props.project, homeRequests()).length === 0 &&
    projectThreads(props.project).length === 0 &&
    issues()?.issues.length === 0 &&
    settled(listing)?.files.length === 0
  return (
    <Show when={empty()} fallback={props.children}>
      <OverviewEmpty {...props} />
    </Show>
  )
}

/** A thread's second line: what it is doing, how long ago it last moved, and the pull requests its issues link. */
export function ThreadMeta(props: { thread: ThreadSummary; pulls: number }): JSX.Element {
  const state = () => visualState(props.thread.status)
  return (
    <span class="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
      <span class="min-w-0 truncate" classList={{ "im-shimmer": state() === "working" }}>
        {props.thread.statusLine ?? STATE_WORD[state()]}
      </span>
      <Show when={props.thread.beatAt}>{(at) => <span class="shrink-0">· {ago(at())}</span>}</Show>
      <Show when={props.pulls > 0}>
        <span class="flex shrink-0 items-center gap-1 text-merged">
          · <GitPullRequest size={12} stroke-width={1.5} />
          <span>{props.pulls === 1 ? "1 PR" : `${props.pulls} PRs`}</span>
        </span>
      </Show>
    </span>
  )
}

export function Section(props: { label: string; count: number; action?: JSX.Element; children: JSX.Element }): JSX.Element {
  const [open, setOpen] = createSignal(true)
  const [instant, setInstant] = createSignal(false)
  let list: HTMLDivElement | undefined
  stagger(() => list, () => props.count > 0)
  return (
    <section aria-label={props.label} class="flex flex-col">
      <div class="flex h-[var(--h-section)] items-center rounded-md bg-secondary pr-1">
        <button
          type="button"
          aria-expanded={open()}
          onClick={() => {
            setInstant(keyStarted())
            setOpen((value) => !value)
          }}
          class="focus-inset flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm text-ink"
        >
          {props.label}
          <span class="text-sm text-ink-3">{props.count}</span>
          <ChevronRight
            size={14}
            stroke-width={1.5}
            class="im-chevron text-ink-3"
            data-open={open() ? "" : undefined}
            data-instant={instant() ? "" : undefined}
          />
        </button>
        {props.action}
      </div>
      <div class="im-grow" data-open={open() ? "" : undefined} data-instant={instant() ? "" : undefined}>
        <div inert={!open()}>
          <div ref={list} class="flex flex-col py-1">
            {props.children}
          </div>
        </div>
      </div>
    </section>
  )
}

export type PaneContext = {
  readonly project: ProjectSummary
  readonly captain?: CaptainProfile | undefined
  readonly conversationId: number
  readonly onOpenThread: (id: number) => void
}

export function NeedsYouSection(props: PaneContext & { label: string }): JSX.Element {
  const requests = () => spaceRequests(props.project, homeRequests())
  const titles = createMemo(() => new Map(projectThreads(props.project).map((thread) => [thread.id, thread.title])))
  return (
    <Show when={requests().length > 0}>
      <Section label={props.label} count={requests().length}>
        <For each={requests()}>
          {(request) => (
            <button type="button" onClick={() => props.onOpenThread(request.conversationId)} class={PANE_ROW}>
              <MessageCircleQuestion size={16} stroke-width={1.5} class="mt-0.5 shrink-0 text-needs" />
              <span class="min-w-0 flex-1">
                <span class="line-clamp-2 text-sm text-ink">{request.question}</span>
                <span class="block truncate text-xs text-ink-3">
                  {request.threadTitle ?? titles().get(request.conversationId) ?? "Thread"}
                </span>
              </span>
              <span class="shrink-0 font-mono text-2xs text-ink-3">{ago(request.askedAt)}</span>
            </button>
          )}
        </For>
      </Section>
    </Show>
  )
}

/** Waiting and working threads first, each with its state, age and linked pull requests. */
export function ThreadsSection(props: PaneContext & { label: string }): JSX.Element {
  const threads = () => {
    const groups = props.project.threads
    return [...groups.waiting, ...groups.working, ...groups.failed, ...groups.completed, ...groups.cancelled]
  }
  const { pullsOf } = createPaneIssues(() => props)
  return (
    <Section
      label={props.label}
      count={threads().length}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="All threads" onClick={() => showPaneView(props.project.id, "threads")}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <For each={threads()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">No threads yet</span>}>
        {(thread) => (
          <button type="button" onClick={() => props.onOpenThread(thread.id)} class={PANE_ROW}>
            <Signal state={visualState(thread.status)} size={16} class="mt-0.5 shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-ink">{thread.title}</span>
              <ThreadMeta thread={thread} pulls={pullsOf(thread.id)} />
            </span>
          </button>
        )}
      </For>
    </Section>
  )
}
