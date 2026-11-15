import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { ArrowUpRight, ChevronRight, File, MessageCircleQuestion } from "lucide-solid"
import { ago } from "../../lib/format.ts"
import { keyStarted, stagger } from "../../lib/motion.ts"
import { homeRequests, projectThreads, type ProjectSummary } from "../../state/home.ts"
import { spaceRequests } from "../../lib/spaces.ts"
import type { CaptainProfile } from "../../lib/captains.ts"
import { showPaneView } from "../../state/tabs.ts"
import { ICON_BUTTON } from "../shell/menu.ts"
import { fileName, openFile, PANE_ROW, recentProjectFiles, ThreadLine } from "./bodies.tsx"

const DRIVE_ROWS = 4

export function Section(props: { label: string; count: number; action?: JSX.Element; children: JSX.Element }): JSX.Element {
  const [open, setOpen] = createSignal(true)
  const [instant, setInstant] = createSignal(false)
  let list: HTMLDivElement | undefined
  stagger(() => list, () => props.count > 0)
  return (
    <div class="flex flex-col">
      <div class="flex h-[var(--h-section)] items-center rounded-md bg-secondary pr-1">
        <button
          type="button"
          aria-expanded={open()}
          onClick={() => {
            setInstant(keyStarted())
            setOpen((value) => !value)
          }}
          class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-sm text-ink outline-none"
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
    </div>
  )
}

export type PaneContext = {
  readonly project: ProjectSummary
  readonly captain?: CaptainProfile | undefined
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

export function InProgressSection(props: PaneContext & { label: string }): JSX.Element {
  const threads = () => [...props.project.threads.waiting, ...props.project.threads.working]
  return (
    <Section label={props.label} count={threads().length}>
      <For each={threads()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">Nothing is running</span>}>
        {(thread) => <ThreadLine thread={thread} onOpen={props.onOpenThread} />}
      </For>
    </Section>
  )
}

export function ThreadsSection(props: PaneContext & { label: string }): JSX.Element {
  const threads = () => projectThreads(props.project)
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
        {(thread) => <ThreadLine thread={thread} onOpen={props.onOpenThread} />}
      </For>
    </Section>
  )
}

export function DriveSection(props: PaneContext & { label: string }): JSX.Element {
  const [files] = createResource(() => props.project.slug, recentProjectFiles)
  return (
    <Section
      label={props.label}
      count={files()?.length ?? 0}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="Open Files" onClick={() => showPaneView(props.project.id, "files")}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <For
        each={(files() ?? []).slice(0, DRIVE_ROWS)}
        fallback={<span class="px-2 py-1.5 text-sm text-ink-3">{files.loading ? "Loading files" : "No files yet"}</span>}
      >
        {(entry) => (
          <button type="button" onClick={() => openFile(props.project.slug, entry.path)} class={PANE_ROW}>
            <File size={16} stroke-width={1.5} class="mt-0.5 shrink-0 text-ink-3" />
            <span class="min-w-0 flex-1 truncate text-sm text-ink">{fileName(entry.path)}</span>
            <span class="shrink-0 font-mono text-2xs text-ink-3">{ago(entry.updated_at)}</span>
          </button>
        )}
      </For>
    </Section>
  )
}
