import { createMemo, createResource, For, Show, type JSX } from "solid-js"
import { Collapsible } from "@ark-ui/solid/collapsible"
import { ArrowUpRight, ChevronDown, File, MessageCircleQuestion } from "lucide-solid"
import { ago } from "../../lib/format.ts"
import { homeRequests, projectThreads, type ProjectSummary } from "../../state/home.ts"
import { showPaneView } from "../../state/tabs.ts"
import { ICON_BUTTON } from "../shell/menu.ts"
import { fileName, openFile, PANE_ROW, recentProjectFiles, ThreadLine } from "./bodies.tsx"
import { settled } from "./drive.tsx"

const DRIVE_ROWS = 4

export function Section(props: { label: string; count: number; action?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <Collapsible.Root defaultOpen class="flex flex-col">
      <div class="flex h-[var(--h-section)] items-center rounded-md bg-secondary pr-1">
        <Collapsible.Trigger class="group flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-sm text-ink outline-none">
          {props.label}
          <span class="text-sm text-ink-3">{props.count}</span>
          <ChevronDown
            size={14}
            stroke-width={1.5}
            class="text-ink-3 transition-transform duration-[var(--dur-fast)] group-data-[state=closed]:-rotate-90"
          />
        </Collapsible.Trigger>
        {props.action}
      </div>
      <Collapsible.Content class="flex flex-col py-1">{props.children}</Collapsible.Content>
    </Collapsible.Root>
  )
}

export type PaneContext = {
  readonly project: ProjectSummary
  readonly conversationId: number
  readonly onOpenThread: (id: number) => void
}

export function NeedsYouSection(props: PaneContext & { label: string }): JSX.Element {
  const requests = () => homeRequests().filter((request) => request.projectId === props.project.id)
  const titles = createMemo(() => new Map(projectThreads(props.project).map((thread) => [thread.id, thread.title])))
  return (
    <Show when={props.project.openRequests > 0}>
      <Section label={props.label} count={props.project.openRequests}>
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
  const [listing] = createResource(() => props.project.slug, recentProjectFiles)
  const files = () => settled(listing)?.files
  return (
    <Section
      label={props.label}
      count={files()?.length ?? 0}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="Open Drive" onClick={() => showPaneView(props.project.id, "files")}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <For
        each={(files() ?? []).slice(0, DRIVE_ROWS)}
        fallback={<span class="px-2 py-1.5 text-sm text-ink-3">{listing.loading ? "Loading files" : listing.error === undefined ? "No files yet" : "Drive is unavailable"}</span>}
      >
        {(entry) => (
          <button type="button" onClick={() => openFile(props.project.slug, `${settled(listing)?.root ?? ""}${entry.path}`)} class={PANE_ROW}>
            <File size={16} stroke-width={1.5} class="mt-0.5 shrink-0 text-ink-3" />
            <span class="min-w-0 flex-1 truncate text-sm text-ink">{fileName(entry.path)}</span>
            <span class="shrink-0 font-mono text-2xs text-ink-3">{ago(entry.updated_at)}</span>
          </button>
        )}
      </For>
    </Section>
  )
}
