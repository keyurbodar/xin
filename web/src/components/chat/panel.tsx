import { For, Show, Switch, Match, createResource, createSignal, type JSX } from "solid-js"
import type { Streams } from "../../lib/api.ts"
import { cmd } from "../../lib/api.ts"
import { ago, bytes, describeRule } from "../../lib/format.ts"
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
import { EmptyState, PanelGhost } from "./ui.tsx"
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

type Note = {
  readonly id: number
  readonly scope: string
  readonly text: string
  readonly at: number
  readonly source?: string
  readonly pinned?: boolean
}

type Schedule = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly rrule?: string
  readonly at?: string
  readonly target: string
  readonly active: boolean
  readonly nextAt: string | null
  readonly updatedAt: string
  readonly lastDelivery?: { readonly scheduledAt: string; readonly deliveredAt: string }
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function ResourceError(props: { what: string; error: unknown; onRetry: () => void }): JSX.Element {
  return (
    <div class="flex flex-col gap-2 border-b border-line px-3 py-4">
      <span class="text-[12.5px] text-fg-2">Couldn’t load {props.what}.</span>
      <span class="font-mono text-[11px] text-bad">{errorMessage(props.error)}</span>
      <button type="button" class="link self-start" onClick={() => props.onRetry()}>
        Retry
      </button>
    </div>
  )
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
        fallback={<EmptyState icon="layers" title="No threads yet" detail="Ask the coordinator to start one; it appears here and in the chat." />}
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
            fallback={<EmptyState icon="file" title="No files yet" detail="Files a thread writes land here under the project folder." />}
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
                    class="flex items-center gap-2.5 border-b border-line px-3 py-2.5 text-left transition-none hover:bg-hover"
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

function MemoryTab(): JSX.Element {
  const [notes, { refetch }] = createResource(() => cmd<{ readonly notes: readonly Note[] }>("memory.list", {}))
  const [busy, setBusy] = createSignal<number | undefined>()
  const [editing, setEditing] = createSignal<number | undefined>()
  const [draft, setDraft] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [posting, setPosting] = createSignal(false)
  const [fresh, setFresh] = createSignal("")
  const [failed, setFailed] = createSignal<string | undefined>()

  const act = async (note: Note, op: string, args: Record<string, unknown>): Promise<void> => {
    setBusy(note.id)
    setFailed(undefined)
    try {
      await cmd(op, args)
      setEditing(undefined)
      await refetch()
    } catch (problem) {
      setFailed(errorMessage(problem))
    } finally {
      setBusy(undefined)
    }
  }

  const forget = (note: Note): Promise<void> => act(note, "memory.forget", { query: note.text })
  const pin = (note: Note): Promise<void> => act(note, "memory.pin", { id: note.id, pinned: note.pinned !== true })
  const save = async (note: Note): Promise<void> => {
    const text = draft().trim()
    if (text === "" || text === note.text) {
      setEditing(undefined)
      return
    }
    await act(note, "memory.edit", { id: note.id, text })
  }
  const openEdit = (note: Note): void => {
    setDraft(note.text)
    setEditing(note.id)
  }
  const add = async (): Promise<void> => {
    const text = fresh().trim()
    if (text === "") return
    setPosting(true)
    setFailed(undefined)
    try {
      await cmd("memory.add", { text })
      setFresh("")
      setAdding(false)
      await refetch()
    } catch (problem) {
      setFailed(errorMessage(problem))
    } finally {
      setPosting(false)
    }
  }

  return (
    <Skullet loading={notes.loading} sample={() => <PanelGhost rows={6} />} label="Loading memory">
      <Show when={notes.error} fallback={null}>
        <ResourceError what="memory" error={notes.error} onRetry={() => void refetch()} />
      </Show>
      <div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span class="flex-1 text-[12px] leading-[1.5] text-fg-3">
          What the coordinator keeps between chats. Every thread can read it.
        </span>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 transition-none hover:border-line-strong hover:text-fg"
          onClick={() => setAdding((open) => !open)}
        >
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>
      <Show when={adding()}>
        <div class="flex flex-col gap-2 border-b border-line px-3 py-3">
          <textarea
            rows={2}
            autofocus
            placeholder="A fact worth keeping across chats"
            class="w-full resize-none rounded-[3px] border border-line-strong bg-surface px-2 py-1.5 text-[13px] leading-[1.5] text-fg outline-none placeholder:text-fg-4 focus:border-accent-line"
            value={fresh()}
            onInput={(event) => setFresh(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAdding(false)
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void add()
            }}
          />
          <div class="flex items-center gap-2">
            <button
              type="button"
              disabled={posting() || fresh().trim() === ""}
              class="rounded-[2px] border border-line px-2 py-1 text-[11.5px] text-fg-2 transition-none hover:border-line-strong hover:text-fg disabled:opacity-50"
              onClick={() => void add()}
            >
              Remember
            </button>
            <button type="button" class="link text-[11.5px]" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <Show when={failed()}>
        {(message) => <div class="border-b border-line px-3 py-2 text-[12px] text-bad">{message()}</div>}
      </Show>
      <Show when={notes()}>
        {(data) => (
          <Show
            when={data().notes.length > 0}
            fallback={<EmptyState icon="brain" title="Nothing remembered yet" detail="Facts the coordinator keeps between chats appear here." />}
          >
            <div class="flex flex-col">
              <For each={data().notes}>
                {(note) => (
                  <div class="group flex items-start gap-2 border-b border-line px-3 py-3">
                    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Show
                        when={editing() === note.id}
                        fallback={<span class="text-[13px] leading-[1.5] text-fg">{note.text}</span>}
                      >
                        <textarea
                          rows={3}
                          class="w-full resize-none rounded-[3px] border border-line-strong bg-surface px-2 py-1.5 text-[13px] leading-[1.5] text-fg outline-none focus:border-accent-line"
                          value={draft()}
                          onInput={(event) => setDraft(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setEditing(undefined)
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(note)
                          }}
                        />
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={busy() === note.id}
                            class="rounded-[2px] border border-line px-2 py-1 text-[11.5px] text-fg-2 transition-none hover:border-line-strong hover:text-fg disabled:opacity-50"
                            onClick={() => void save(note)}
                          >
                            Save
                          </button>
                          <button type="button" class="link text-[11.5px]" onClick={() => setEditing(undefined)}>
                            Cancel
                          </button>
                        </div>
                      </Show>
                      <span class="flex flex-wrap items-center gap-2 text-[11.5px] text-fg-3">
                        <span class="flex items-center gap-1">
                          <Icon name={note.source === "dreamer" ? "brain" : "message"} size={12} class="text-fg-4" />
                          {note.source === "dreamer" ? "Learned by the coordinator" : "You said"}
                        </span>
                        <span class="text-fg-4">·</span>
                        {ago(note.at)}
                        <Show when={note.scope !== "me"}>
                          <span class="rounded-[2px] border border-line-inner px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em]">
                            {note.scope}
                          </span>
                        </Show>
                        <Show when={note.pinned === true}>
                          <span class="rounded-[2px] border border-accent-line bg-accent-dim px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-accent-text">
                            Pinned
                          </span>
                        </Show>
                      </span>
                    </div>
                    <Show when={editing() !== note.id}>
                      <div class="mt-0.5 flex shrink-0 items-center opacity-0 transition-none group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label={note.pinned === true ? "Unpin this" : "Pin this"}
                          disabled={busy() === note.id}
                          class="rounded-[2px] p-1 hover:bg-hover disabled:opacity-50"
                          classList={{ "text-accent-text": note.pinned === true, "text-fg-4 hover:text-fg-2": note.pinned !== true }}
                          onClick={() => void pin(note)}
                        >
                          <Icon name="pin" size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="Edit this"
                          disabled={busy() === note.id}
                          class="rounded-[2px] p-1 text-fg-4 hover:bg-hover hover:text-fg-2 disabled:opacity-50"
                          onClick={() => openEdit(note)}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="Forget this"
                          disabled={busy() === note.id}
                          class="rounded-[2px] p-1 text-fg-4 hover:bg-hover hover:text-fg-2 disabled:opacity-50"
                          onClick={() => void forget(note)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
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

function nextRun(value: string | null): string {
  if (value === null) return "not scheduled"
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function ruleOf(schedule: Schedule): string {
  if (schedule.rrule !== undefined) return describeRule(schedule.rrule)
  if (schedule.at !== undefined) {
    const at = Date.parse(schedule.at)
    if (!Number.isNaN(at)) return new Date(at).toLocaleString()
    return schedule.at
  }
  return "no rule"
}

function SchedulesTab(): JSX.Element {
  const [schedules, { refetch }] = createResource(() =>
    cmd<{ readonly schedules: readonly Schedule[] }>("schedule.list", {}),
  )
  const [busy, setBusy] = createSignal<string | undefined>()
  const [failed, setFailed] = createSignal<string | undefined>()
  const toggle = async (schedule: Schedule): Promise<void> => {
    setBusy(schedule.id)
    setFailed(undefined)
    try {
      await cmd("schedule.edit", { action: "update", id: schedule.id, active: !schedule.active })
      await refetch()
    } catch (problem) {
      setFailed(errorMessage(problem))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <Skullet loading={schedules.loading} sample={() => <PanelGhost rows={4} />} label="Loading schedules">
      <Show when={schedules.error} fallback={null}>
        <ResourceError what="schedules" error={schedules.error} onRetry={() => void refetch()} />
      </Show>
      <div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span class="min-w-0 flex-1 text-[12px] leading-[1.5] text-fg-3">
          Starts a thread on a timer. Results land in this chat.
        </span>
        <button
          type="button"
          class="shrink-0 rounded-[2px] border border-line px-2 py-1 text-[12px] text-fg-2 transition-none hover:border-line-strong hover:text-fg"
          onClick={() => navigate("/schedules")}
        >
          New
        </button>
      </div>
      <Show when={failed()}>
        {(message) => <div class="border-b border-line px-3 py-2 text-[12px] text-bad">{message()}</div>}
      </Show>
      <Show when={schedules()}>
        {(data) => (
          <Show
            when={data().schedules.length > 0}
            fallback={<EmptyState icon="calendar" title="No schedules" detail="A schedule starts a thread on a timer; its results land in this chat." />}
          >
            <div class="flex flex-col">
              <For each={data().schedules}>
                {(schedule) => (
                  <div class="flex flex-col gap-1.5 border-b border-line px-3 py-3" classList={{ "opacity-60": !schedule.active }}>
                    <div class="flex items-center gap-2">
                      <StatusGlyph state={schedule.active ? "queued" : "paused"} size={16} />
                      <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{schedule.title}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={schedule.active}
                        aria-label={schedule.active ? `Pause ${schedule.title}` : `Resume ${schedule.title}`}
                        disabled={busy() === schedule.id}
                        class="relative h-4 w-7 shrink-0 rounded-[2px] transition-none disabled:opacity-50"
                        classList={{ "bg-fg": schedule.active, "bg-line-strong": !schedule.active }}
                        onClick={() => void toggle(schedule)}
                      >
                        <span
                          class="absolute top-0.5 h-3 w-3 rounded-[1px] bg-page"
                          classList={{ "left-3.5": schedule.active, "left-0.5": !schedule.active }}
                        />
                      </button>
                    </div>
                    <div class="flex items-center gap-1.5 text-[12px] text-fg-3">
                      <Icon name="refresh" size={12} />
                      <span class="truncate">{ruleOf(schedule)}</span>
                    </div>
                    <div class="flex items-center gap-2 font-mono text-[10.5px] text-fg-4">
                      <span>next {nextRun(schedule.nextAt)}</span>
                      <Show when={schedule.lastDelivery}>
                        {(last) => <span>· last ran {ago(Date.parse(last().deliveredAt))}</span>}
                      </Show>
                    </div>
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
                icon="clock"
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
  variant?: "sidebar" | "sheet" | undefined
}): JSX.Element {
  const [tab, setTab] = createSignal<Tab>("threads")
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

  return (
    <Show when={props.open}>
      <aside
        class="w-[360px] shrink-0 flex-col border-l border-line bg-surface"
        classList={{
          "hidden min-[1280px]:flex": props.variant !== "sheet",
          "flex w-full flex-1 border-l-0": props.variant === "sheet",
        }}
      >
        <Show
          when={props.thread}
          fallback={
            <>
              <div class="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3">
                <For each={TABS}>
                  {(entry) => (
                    <button
                      type="button"
                      onClick={() => setTab(entry.id)}
                      class="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-2 text-[12.5px] transition-none"
                      classList={{
                        "bg-selected text-fg": tab() === entry.id,
                        "text-fg-3 hover:bg-hover hover:text-fg-2": tab() !== entry.id,
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
              <div class="min-h-0 flex-1 overflow-y-auto">
                <Switch>
                  <Match when={tab() === "threads"}>
                    <ThreadsTab project={props.project} onOpenThread={props.onOpenThread} />
                  </Match>
                  <Match when={tab() === "files"}>
                    <FilesTab slug={props.project.slug} />
                  </Match>
                  <Match when={tab() === "memory"}>
                    <MemoryTab />
                  </Match>
                  <Match when={tab() === "schedules"}>
                    <SchedulesTab />
                  </Match>
                  <Match when={tab() === "jobs"}>
                    <JobsTab />
                  </Match>
                </Switch>
              </div>
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
