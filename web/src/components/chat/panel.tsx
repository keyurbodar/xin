import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import type { Streams } from "../../lib/api.ts"
import { cmd } from "../../lib/api.ts"
import { ago, bytes } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { STATE_COLOR, STATE_WORD, visualState, type VisualState } from "../../lib/status.ts"
import type { ProjectSummary, ThreadSummary } from "../../state/home.ts"
import {
  createConversationView,
  liveOf,
  type AnsweredView,
  type RequestRow,
  type Snapshot,
} from "../../state/conversation.ts"
import { Icon } from "../ui/icon.tsx"
import { StatusGlyph } from "../ui/status-glyph.tsx"
import { Skullet } from "../ui/skeleton.tsx"
import { EmptyState, PanelGhost, ResourceError } from "./ui.tsx"
import { MemoryTab } from "./memory.tsx"
import { SchedulesTab } from "./schedules.tsx"
import { AnsweredQuestionCard, OpenQuestionCard, ThreadRow } from "./cards.tsx"
import { EntryList, itemsOf, type ItemContext } from "./entries.tsx"
import { SteerComposer } from "./composer.tsx"

type Tab = "threads" | "files" | "memory" | "schedules" | "jobs"

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: "threads", label: "Threads" },
  { id: "files", label: "Files" },
  { id: "memory", label: "Memory" },
  { id: "schedules", label: "Schedules" },
  { id: "jobs", label: "Jobs" },
]

type FileEntry = {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly sha256: string
  readonly project: string | null
  readonly updated_at: number
}

function Group(props: { label: string; count: number; tint?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <section>
      <div class="flex items-center gap-1.5 px-3 pb-1 pt-3.5">
        <Icon name="chevron-down" size={12} class="text-fg-4" />
        <span class="label" classList={{ "text-accent-text": props.tint === true }}>
          {props.label}
        </span>
        <span class="mono-meta">{props.count}</span>
      </div>
      <div class="flex flex-col px-1">{props.children}</div>
    </section>
  )
}

function ThreadsTab(props: { project: ProjectSummary; onOpenThread: (id: number) => void }): JSX.Element {
  const groups = () => props.project.threads
  return (
    <div class="flex flex-col pb-6">
      <Show when={groups().waiting.length + groups().working.length + groups().completed.length + groups().failed.length + groups().cancelled.length > 0}
        fallback={<EmptyState pictogram="threads" title="No threads yet" detail="Ask the coordinator to start one; it appears here and in the chat." />}
      >
        <Show when={groups().waiting.length > 0}>
          <Group label="Waiting on you" count={groups().waiting.length} tint>
            <For each={groups().waiting}>
              {(thread) => <ThreadRow flush thread={thread} title={thread.title} role={thread.role ?? "thread"} onClick={() => props.onOpenThread(thread.id)} />}
            </For>
          </Group>
        </Show>
        <Show when={groups().working.length > 0}>
          <Group label="Working" count={groups().working.length}>
            <For each={groups().working}>
              {(thread) => <ThreadRow flush thread={thread} title={thread.title} role={thread.role ?? "thread"} onClick={() => props.onOpenThread(thread.id)} />}
            </For>
          </Group>
        </Show>
        <Show when={groups().completed.length > 0}>
          <Group label="Done" count={groups().completed.length}>
            <For each={groups().completed}>
              {(thread) => <ThreadRow flush thread={thread} title={thread.title} role={thread.role ?? "thread"} onClick={() => props.onOpenThread(thread.id)} />}
            </For>
          </Group>
        </Show>
        <Show when={groups().failed.length > 0}>
          <Group label="Failed" count={groups().failed.length}>
            <For each={groups().failed}>
              {(thread) => <ThreadRow flush thread={thread} title={thread.title} role={thread.role ?? "thread"} onClick={() => props.onOpenThread(thread.id)} />}
            </For>
          </Group>
        </Show>
        <Show when={groups().cancelled.length > 0}>
          <Group label="Cancelled" count={groups().cancelled.length}>
            <For each={groups().cancelled}>
              {(thread) => <ThreadRow flush thread={thread} title={thread.title} role={thread.role ?? "thread"} onClick={() => props.onOpenThread(thread.id)} />}
            </For>
          </Group>
        </Show>
      </Show>
    </div>
  )
}

function FilesTab(props: { slug: string }): JSX.Element {
  const [files, { refetch }] = createResource(
    () => props.slug,
    (slug) => cmd<readonly FileEntry[]>("file.list", { prefix: `/projects/${slug}` }),
  )
  const root = (): string => `/projects/${props.slug}/`
  const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
  const folder = (path: string): string => {
    const relative = path.startsWith(root()) ? path.slice(root().length) : path
    const cut = relative.lastIndexOf("/")
    return cut === -1 ? "project root" : relative.slice(0, cut)
  }

  return (
    <Skullet loading={files.loading} sample={() => <PanelGhost rows={7} />} label="Loading files">
      <Show when={files.error} fallback={null}>
        <ResourceError what="files" error={files.error} onRetry={() => void refetch()} />
      </Show>
      <Show when={files()}>
        {(rows) => (
          <Show
            when={rows().length > 0}
            fallback={<EmptyState pictogram="folder" title="No files yet" detail="Files a thread writes land here under the project folder." />}
          >
            <div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <span class="label flex-1">{rows().length} files</span>
              <span class="truncate font-mono text-[10.5px] text-fg-4">{root()}</span>
            </div>
            <div class="flex flex-col">
              <For each={rows().toSorted((left, right) => right.updated_at - left.updated_at)}>
                {(entry) => (
                  <button
                    type="button"
                    onClick={() => navigate(`/p/${props.slug}/files/${encodeURIComponent(entry.path)}`)}
                    class="flex items-center gap-2.5 border-b border-line px-3 py-2.5 text-left hover:bg-hover"
                  >
                    <Icon name="file" size={15} class="shrink-0 text-fg-3" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[13px] text-fg">{name(entry.path)}</span>
                      <span class="block truncate text-[11.5px] text-fg-3">
                        {folder(entry.path)} · {ago(entry.updated_at)}
                      </span>
                    </span>
                    <span class="mono-meta shrink-0">{bytes(entry.size)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </Skullet>
  )
}

type JobEntry = {
  readonly id: number
  readonly tool: string
  readonly title: string
  readonly startedAt: number
  readonly deadlineAt: number
  readonly state: "running" | "completed" | "failed"
  readonly result?: string
}

function JobsTab(): JSX.Element {
  const [jobs, { refetch }] = createResource(() => cmd<{ readonly jobs: readonly JobEntry[] }>("job.list", {}))
  return (
    <Skullet loading={jobs.loading} sample={() => <PanelGhost rows={4} />} label="Loading jobs">
      <Show when={jobs.error} fallback={null}>
        <ResourceError what="jobs" error={jobs.error} onRetry={() => void refetch()} />
      </Show>
      <Show when={jobs()}>
        {(data) => (
          <Show
            when={data().jobs.length > 0}
            fallback={
              <EmptyState
                pictogram="jobs"
                title="No jobs"
                detail="A job runs one long tool call in the background and reports back here."
              />
            }
          >
            <div class="flex flex-col">
              <For each={data().jobs}>
                {(job) => (
                  <div class="flex flex-col gap-1.5 border-b border-line px-3 py-3">
                    <div class="flex items-center gap-2">
                      <StatusGlyph state={job.state === "running" ? "working" : job.state === "failed" ? "failed" : "done"} size={16} />
                      <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{job.title}</span>
                      <span class="mono-meta shrink-0">{job.state}</span>
                    </div>
                    <div class="flex items-center gap-1.5 text-[12px] text-fg-3">
                      <Icon name="clock" size={12} />
                      <span class="truncate">{job.tool}</span>
                      <span class="ml-auto shrink-0 font-mono text-[10.5px] text-fg-4">{ago(job.startedAt)}</span>
                    </div>
                    <Show when={job.result}>
                      {(text) => <p class="line-clamp-3 text-[12px] leading-[1.55] text-fg-2">{text()}</p>}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </Skullet>
  )
}

function ThreadBody(props: {
  snapshot: Snapshot
  title: string
  requests: readonly RequestRow[]
  answered: readonly AnsweredView[]
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
}): JSX.Element {
  const live = () => liveOf(props.snapshot)
  const context: ItemContext = {
    project: undefined,
    threads: [],
    links: new Map(),
    requests: props.requests,
    density: "panel",
    onOpenThread: () => undefined,
    onAnswer: props.onAnswer,
    onRetry: async (entryId) => {
      await cmd("message.retry", { entryId })
    },
  }
  return (
    <div class="flex flex-col gap-3 px-3 py-3">
      <For each={props.requests}>
        {(request) => (
          <OpenQuestionCard
            title={props.title}
            request={request}
            onAnswer={async (_requestId, answer) => {
              await props.onAnswer(request, answer)
            }}
          />
        )}
      </For>
      <For each={props.answered}>
        {(item) => <AnsweredQuestionCard question={item.question} answer={item.answer} answeredAt={item.answeredAt} />}
      </For>
      <EntryList items={itemsOf(props.snapshot.entries)} context={context} />
      <Show when={live().busy}>
        <div class="text-[12.5px] text-fg-3">
          <span class="shimmer">Working…</span>
        </div>
      </Show>
    </div>
  )
}

function ThreadDetail(props: {
  thread: ThreadSummary
  streams: Streams
  requests: readonly RequestRow[]
  answered: readonly AnsweredView[]
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
  onBack: () => void
}): JSX.Element {
  const snapshot = createConversationView(props.streams, () => props.thread.id)
  const state = (): VisualState => visualState(props.thread.status)
  const busy = (): boolean => state() === "working"
  const waiting = (): boolean => state() === "waiting"
  const requests = (): readonly RequestRow[] =>
    props.requests.filter((request) => request.conversationId === props.thread.id)
  const answered = (): readonly AnsweredView[] =>
    props.answered.filter((item) => item.conversationId === props.thread.id)

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
        <button
          type="button"
          onClick={() => props.onBack()}
          aria-label="Back to panel"
          class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <StatusGlyph state={state()} size={16} />
        <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{props.thread.title}</span>
        <button
          type="button"
          onClick={() => props.onBack()}
          aria-label="Close thread"
          class="grid h-7 w-7 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      <div
        class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]"
        style={{ color: STATE_COLOR[state()] }}
      >
        <span class="min-w-0 flex-1 truncate">
          {props.thread.statusLine ?? STATE_WORD[state()]}
        </span>
        <span class="shrink-0 font-mono text-[10.5px] text-fg-4">{ago(props.thread.beatAt)}</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Skullet loading={snapshot() === undefined} sample={() => <PanelGhost rows={6} />} label="Loading thread">
          <Show when={snapshot()}>
            {(value) => (
              <ThreadBody
                snapshot={value()}
                title={props.thread.title}
                requests={requests()}
                answered={answered()}
                onAnswer={props.onAnswer}
              />
            )}
          </Show>
        </Skullet>
      </div>
      <SteerComposer
        threadTitle={props.thread.title}
        busy={busy()}
        waiting={waiting()}
        onSend={async (text) => {
          await cmd("thread.send", {
            threadId: props.thread.id,
            text,
            mode: busy() ? "steer" : "queue",
          })
        }}
        onStop={async () => {
          await cmd("thread.stop", { threadId: props.thread.id })
        }}
      />
    </div>
  )
}

export function ProjectPanel(props: {
  project: ProjectSummary
  streams: Streams
  open: boolean
  thread: ThreadSummary | undefined
  requests: readonly RequestRow[]
  answered: readonly AnsweredView[]
  onAnswer: (request: RequestRow, answer: string) => Promise<void>
  onOpenThread: (id: number) => void
  onCloseThread: () => void
  onClose?: (() => void) | undefined
  variant?: "sidebar" | "drawer" | "sheet" | undefined
}): JSX.Element {
  const [tab, setTab] = createSignal<Tab>("threads")
  const [pill, setPill] = createSignal({ left: 0, width: 0 })
  let strip: HTMLDivElement | undefined
  const measure = (): void => {
    const active = strip?.querySelector<HTMLElement>('[data-tab-active="true"]')
    if (active === undefined || active === null) return
    setPill({ left: active.offsetLeft, width: active.offsetWidth })
  }
  createEffect(() => {
    tab()
    requestAnimationFrame(measure)
  })
  onMount(() => {
    measure()
    if (strip === undefined) return
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    onCleanup(() => observer.disconnect())
  })
  const threadCount = (): number => {
    const groups = props.project.threads
    return (
      groups.working.length +
      groups.waiting.length +
      groups.completed.length +
      groups.failed.length +
      groups.cancelled.length
    )
  }

  const docked = (): boolean => props.variant === undefined || props.variant === "sidebar"

  return (
    <Show when={props.open}>
      <aside
        class="flex min-h-0 shrink-0 flex-col bg-surface"
        classList={{
          "w-[400px] border-l border-line min-[1440px]:w-[440px]": docked() && props.thread === undefined,
          "w-[520px] border-l border-line": docked() && props.thread !== undefined,
          "w-full": props.variant === "drawer",
          "w-full flex-1 border-l-0": props.variant === "sheet",
        }}
      >
        <Show
          when={props.thread}
          fallback={
            <>
              <div class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
                <div
                  ref={(element) => {
                    strip = element
                  }}
                  class="relative flex flex-1 items-center gap-1 overflow-x-auto"
                >
                  <span
                    aria-hidden="true"
                    class="absolute top-0 left-0 h-7 rounded-[2px] bg-selected transition-[transform,width] duration-200 ease-[var(--ease-standard)]"
                    style={{ transform: `translateX(${pill().left}px)`, width: `${pill().width}px` }}
                  />
                  <For each={TABS}>
                    {(entry) => (
                      <button
                        type="button"
                        onClick={() => setTab(entry.id)}
                        data-tab-active={tab() === entry.id}
                        class="relative z-10 flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-2 text-[12.5px]"
                        classList={{
                          "text-fg": tab() === entry.id,
                          "text-fg-3 hover:text-fg-2": tab() !== entry.id,
                        }}
                      >
                        {entry.label}
                        <Show when={entry.id === "threads" && threadCount() > 0}>
                          <span class="font-mono text-[10px] text-fg-4">{threadCount()}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
                <Show when={props.onClose}>
                  {(close) => (
                    <button
                      type="button"
                      onClick={close()}
                      aria-label="Close the panel"
                      class="grid h-7 w-7 shrink-0 place-items-center rounded-[2px] text-fg-3 hover:bg-hover hover:text-fg"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </Show>
              </div>
              <Show when={tab()} keyed>
                {(current) => (
                  <div class="menu-in min-h-0 flex-1 overflow-y-auto">
                    <Switch>
                      <Match when={current === "threads"}>
                        <ThreadsTab project={props.project} onOpenThread={props.onOpenThread} />
                      </Match>
                      <Match when={current === "files"}>
                        <FilesTab slug={props.project.slug} />
                      </Match>
                      <Match when={current === "memory"}>
                        <MemoryTab conversationId={props.project.coordinatorId} scope={`project:${props.project.id}`} />
                      </Match>
                      <Match when={current === "schedules"}>
                        <SchedulesTab slug={props.project.slug} />
                      </Match>
                      <Match when={current === "jobs"}>
                        <JobsTab />
                      </Match>
                    </Switch>
                  </div>
                )}
              </Show>
            </>
          }
        >
          {(thread) => (
            <ThreadDetail
              thread={thread()}
              streams={props.streams}
              requests={props.requests}
              answered={props.answered}
              onAnswer={props.onAnswer}
              onBack={() => props.onCloseThread()}
            />
          )}
        </Show>
      </aside>
    </Show>
  )
}
