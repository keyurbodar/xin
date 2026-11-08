import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import {
  activeProjects,
  counts,
  homeLoaded,
  homeRequests,
  type ProjectSummary,
  type ThreadSummary,
} from "../state/home.ts"
import { respondToQuestion, retryThread } from "../state/requests.ts"
import { errorMessage } from "../state/extensions.ts"
import { ago, greeting, longDate, money } from "../lib/format.ts"
import { StatusGlyph } from "../components/ui/status-glyph.tsx"
import type { VisualState } from "../lib/status.ts"
import type { RequestRow } from "../state/conversation.ts"
import { Morph } from "../components/ui/morph.tsx"
import { Skullet } from "../components/ui/skeleton.tsx"
import { Icon } from "../components/ui/icon.tsx"
import { navigate } from "../lib/router.ts"
import { projectIcon } from "../lib/project-icon.ts"
import { usage } from "../state/settings.ts"
import { TopBar, TopButton } from "../components/shell/topbar.tsx"

export function HomeScreen(): JSX.Element {
  onMount(() => void usage.reload())
  return (
    <>
      <TopBar
        title="Home"
        actions={
          <>
            <span class="hidden sm:flex">
              <TopButton icon={<Icon name="calendar" size={14} />} label="Schedules" onClick={() => navigate("/schedules")} />
            </span>
            <TopButton icon={<Icon name="plus" size={14} />} label="New project" primary shortcut="N" onClick={() => navigate("/new")} />
          </>
        }
      />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Skullet loading={!homeLoaded()} sample={() => <HomeBody loaded={false} />} label="Loading home">
          <HomeBody loaded />
        </Skullet>
      </div>
    </>
  )
}

type Need = {
  readonly id: string
  readonly state: VisualState
  readonly title: string
  readonly detail: string
  readonly at: number | undefined
  readonly options: readonly string[]
  readonly question: RequestRow | undefined
  readonly threadId: number | undefined
}

/** Pending questions come first, because they can be answered here; failed threads offer a Retry. */
function needs(): readonly Need[] {
  const rows: Need[] = []
  const live = new Set(activeProjects().map((project) => project.id))
  for (const request of homeRequests()) {
    if (!live.has(request.projectId)) continue
    rows.push({
      id: `q:${request.id}`,
      state: "waiting",
      title: request.question,
      detail: [request.projectName, request.threadTitle].filter((part) => part !== undefined && part !== "").join(" · "),
      at: request.askedAt,
      options: request.options,
      question: request,
      threadId: undefined,
    })
  }
  for (const project of activeProjects()) {
    for (const thread of project.threads.failed) {
      rows.push({
        id: `f:${project.id}:${thread.id}`,
        state: "failed",
        title: thread.title,
        detail: [project.name, thread.statusLine].filter((part): part is string => part !== undefined && part !== "").join(" · "),
        at: thread.beatAt,
        options: [],
        question: undefined,
        threadId: thread.id,
      })
    }
  }
  return rows.sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
}

function HomeBody(props: { loaded: boolean }): JSX.Element {
  const numbers = () => (props.loaded ? counts() : { waiting: 0, working: 0, finished: 0, failed: 0 })
  const rows = () => (props.loaded ? needs() : [])
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const [problem, setProblem] = createSignal<string | undefined>(undefined)

  const answer = async (row: Need, option: string): Promise<void> => {
    if (row.question === undefined) return
    setBusy(row.id)
    setProblem(undefined)
    try {
      await respondToQuestion(row.question, option)
    } catch (failure: unknown) {
      setProblem(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const retry = async (row: Need): Promise<void> => {
    if (row.threadId === undefined) return
    setBusy(row.id)
    setProblem(undefined)
    try {
      await retryThread(row.threadId)
    } catch (failure: unknown) {
      setProblem(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const openProject = (projectId: string): void => {
    const project = activeProjects().find((entry) => entry.id === projectId)
    navigate(project === undefined ? "/inbox" : `/p/${project.slug}`)
  }

  return (
    <div class="flex min-h-full flex-col gap-7 px-4 pb-32 pt-5 sm:px-10 sm:pb-12 sm:pt-7">
      <div>
        <div class="label mb-2.5">{longDate()}</div>
        <h1 class="text-[32px] font-light leading-[1.1] tracking-[-0.03em]">{greeting()}.</h1>
      </div>

      <div class="hidden overflow-hidden rounded-[4px] border border-line bg-surface sm:flex">
        <Cell label="Waiting on you" value={numbers().waiting} tone="accent" />
        <Cell label="Working now" value={numbers().working} tone="working" />
        <Cell label="Finished overnight" value={numbers().finished} />
        <Cell label="Failed" value={numbers().failed} />
        <Cell label="Spend today" text={money(spend())} mono />
      </div>

      <Show when={rows().length > 0}>
        <section>
          <div class="mb-2.5 flex items-baseline gap-2.5">
            <span class="label text-accent-text">Needs you</span>
            <span class="text-[12px] text-fg-3">Threads are paused until you answer</span>
            <button type="button" class="ml-auto link" onClick={() => navigate("/inbox")}>
              Open Inbox
            </button>
          </div>
          <div class="flex flex-col overflow-hidden rounded-[4px] border border-accent-line">
            <For each={rows()}>
              {(row) => (
                <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-b border-line bg-raised px-3.5 py-2.5 last:border-0 sm:flex sm:gap-3">
                  <StatusGlyph state={row.state} size={16} />
                  <span class="min-w-0 flex-1 text-left">
                    <span class="block truncate text-[13px] font-medium">{row.title}</span>
                    <span class="block truncate text-[12px] text-fg-3">
                      {row.detail} · {ago(row.at)}
                    </span>
                  </span>
                  <span class="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-auto sm:shrink-0 sm:flex-nowrap">
                    <For each={row.options}>
                      {(option) => (
                        <button
                          type="button"
                          class="chip hover:border-line-strong hover:bg-selected"
                          disabled={busy() === row.id}
                          onClick={() => void answer(row, option)}
                        >
                          {option}
                        </button>
                      )}
                    </For>
                    <Show when={row.threadId !== undefined}>
                      <button type="button" class="chip hover:border-line-strong" onClick={() => void retry(row)}>
                        Retry
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="chip hover:border-line-strong"
                      onClick={() => (row.question === undefined ? navigate("/inbox") : openProject(row.question.projectId))}
                    >
                      {row.question === undefined ? "Open thread" : "Open project"}
                    </button>
                  </span>
                </div>
              )}
            </For>
          </div>
          <Show when={problem()}>
            {(message) => <p class="mt-2 text-[12px] text-bad">{message()}</p>}
          </Show>
        </section>
      </Show>

      <section>
        <div class="mb-2.5 flex items-baseline gap-2.5">
          <span class="label">Projects</span>
          <span class="text-[12px] text-fg-3">{activeProjects().length}</span>
          <span class="ml-auto link">Sort: recent activity</span>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <For each={activeProjects()}>{(project) => <ProjectCard project={project} />}</For>
          <button
            type="button"
            onClick={() => navigate("/new")}
            class="hidden min-h-[180px] flex-col items-center justify-center gap-2 rounded-[4px] border border-dashed border-line-inner text-fg-3 hover:border-line-strong hover:text-fg-2 sm:flex"
          >
            <Icon name="plus" size={18} />
            <span class="text-[12.5px]">New project</span>
          </button>
        </div>
      </section>

      <div class="fixed inset-x-4 bottom-[88px] z-10 sm:hidden">
        <button
          type="button"
          onClick={() => navigate("/new")}
          class="flex h-11 w-full items-center justify-center gap-2 rounded-[2px] bg-accent text-[14px] font-medium text-ink"
        >
          <Icon name="plus" size={16} />
          New project
        </button>
      </div>
    </div>
  )
}

function spend(): number {
  const state = usage.state()
  if (state.kind !== "ready" || !state.value.recorded) return 0
  return state.value.today
}

function Cell(props: { label: string; value?: number; text?: string; tone?: "accent" | "working"; mono?: boolean }): JSX.Element {
  return (
    <div class="flex-1 border-r border-line px-4 py-3.5 last:border-r-0">
      <span class="label">{props.label}</span>
      <span
        class="mt-1.5 block font-light tracking-[-0.02em]"
        classList={{
          "text-[26px]": true,
          "text-accent-text": props.tone === "accent" && (props.value ?? 0) > 0,
          "text-[#a9cbff]": props.tone === "working" && (props.value ?? 0) > 0,
          "font-mono text-[22px]": props.mono === true,
        }}
      >
        <Show when={props.text === undefined} fallback={props.text}>
          <Morph value={String(props.value ?? 0)} />
        </Show>
      </span>
    </div>
  )
}

function ProjectCard(props: { project: ProjectSummary }): JSX.Element {
  const threads = (): readonly { thread: ThreadSummary; state: VisualState }[] => {
    const p = props.project
    return [
      ...p.threads.waiting.map((thread) => ({ thread, state: "waiting" as const })),
      ...p.threads.working.map((thread) => ({ thread, state: "working" as const })),
      ...p.threads.failed.map((thread) => ({ thread, state: "failed" as const })),
      ...p.threads.completed.map((thread) => ({ thread, state: "done" as const })),
    ].slice(0, 3)
  }

  const tally = (): string => {
    const p = props.project
    const done = p.threads.completed.length
    const idle = p.threads.working.length + p.threads.waiting.length + p.threads.failed.length === 0
    if (idle) return done > 0 ? `Idle · ${done} ${done === 1 ? "report" : "reports"}` : "Idle"
    const parts: string[] = []
    if (p.threads.waiting.length + p.openRequests > 0) parts.push(`${p.threads.waiting.length + p.openRequests} waiting`)
    if (p.threads.working.length > 0) parts.push(`${p.threads.working.length} working`)
    if (p.threads.failed.length > 0) parts.push(`${p.threads.failed.length} failed`)
    return parts.join(" · ")
  }

  return (
    <button
      type="button"
      onClick={() => navigate(`/p/${props.project.slug}`)}
      class="flex flex-col gap-3 rounded-[4px] border border-line-inner bg-raised p-3.5 text-left hover:border-line-strong hover:bg-hover"
    >
      <div class="flex items-center gap-2.5">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-surface text-fg-2">
          <Icon name={projectIcon(props.project.slug)} size={16} />
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[14px] font-medium">{props.project.name}</span>
          <span class="block truncate text-[12px] text-fg-3">{props.project.goal ?? "No goal yet"}</span>
        </span>
      </div>

      <div class="flex flex-col gap-1.5">
        <For each={threads()}>
          {(row) => (
            <div class="flex items-center gap-2 text-[12.5px] text-fg-2">
              <StatusGlyph state={row.state} size={16} />
              <span class="min-w-0 flex-1 truncate" classList={{ shimmer: row.state === "working" }}>
                {row.thread.title}
              </span>
              <span class="mono-meta shrink-0">{ago(row.thread.beatAt)}</span>
            </div>
          )}
        </For>
        <Show when={threads().length === 0}>
          <div class="text-[12.5px] text-fg-3">No threads yet</div>
        </Show>
      </div>

      <div class="flex items-center gap-3 border-t border-line pt-2.5 text-[11.5px] text-fg-3">
        <span class="truncate">{tally()}</span>
        <span class="ml-auto shrink-0">{ago(props.project.threads.working[0]?.beatAt ?? props.project.threads.completed[0]?.beatAt)}</span>
      </div>
    </button>
  )
}
