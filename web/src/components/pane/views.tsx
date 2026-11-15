import { For, Show, type JSX } from "solid-js"
import { Brain, CalendarClock, Folder, LayoutList, ListTree, Timer, Users, type LucideProps } from "lucide-solid"
import { MemoryTab } from "../chat/memory.tsx"
import { SchedulesTab } from "../chat/schedules.tsx"
import { FilesView, JobsView, ThreadsView } from "./bodies.tsx"
import { CrewSection, CrewView } from "./crew.tsx"
import { DriveSection, InProgressSection, NeedsYouSection, ThreadsSection, type PaneContext } from "./overview.tsx"

export type { PaneContext }

/** Where a view belongs: a project's own pane, a Captain's, or both when absent. */
type PaneScope = "project" | "captain"

export type PaneEntry = {
  readonly id: string
  readonly label: string
  readonly icon: (props: LucideProps) => JSX.Element
  readonly scope?: PaneScope
  readonly render: (context: PaneContext) => JSX.Element
}

/** Overview's sections, top to bottom. Each renders its own collapsible header and count. */
type OverviewSection = Omit<PaneEntry, "icon">

function section(
  id: string,
  label: string,
  Body: (props: PaneContext & { label: string }) => JSX.Element,
  scope?: PaneScope,
): OverviewSection {
  return { id, label, render: (context) => <Body {...context} label={label} />, ...(scope === undefined ? {} : { scope }) }
}

function fits(entry: { readonly scope?: PaneScope }, context: PaneContext): boolean {
  return entry.scope === undefined || entry.scope === (context.captain === undefined ? "project" : "captain")
}

function CrewOverview(props: PaneContext & { label: string }): JSX.Element {
  return (
    <Show when={props.captain}>
      {(captain) => <CrewSection project={props.project} captain={captain()} onOpenThread={props.onOpenThread} label={props.label} />}
    </Show>
  )
}

export const OVERVIEW_SECTIONS: readonly OverviewSection[] = [
  section("needs", "Needs you", NeedsYouSection),
  section("crew", "Crew", CrewOverview, "captain"),
  section("progress", "In progress", InProgressSection, "project"),
  section("threads", "Threads", ThreadsSection, "project"),
  section("drive", "Drive", DriveSection, "project"),
]

const OVERVIEW_VIEW: PaneEntry = {
  id: "overview",
  label: "Overview",
  icon: LayoutList,
  render: (context) => (
    <div class="flex flex-col gap-1">
      <For each={OVERVIEW_SECTIONS.filter((entry) => fits(entry, context))}>{(entry) => entry.render(context)}</For>
    </div>
  ),
}

/** Every view the right pane can show: its tabs, the + menu, and the body each one renders. */
export const PANE_VIEWS: readonly PaneEntry[] = [
  OVERVIEW_VIEW,
  {
    id: "crew",
    label: "Crew",
    icon: Users,
    scope: "captain",
    render: (context) => (
      <Show when={context.captain}>
        {(captain) => <CrewView project={context.project} captain={captain()} onOpenThread={context.onOpenThread} />}
      </Show>
    ),
  },
  { id: "files", label: "Files", icon: Folder, scope: "project", render: (context) => <FilesView slug={context.project.slug} /> },
  {
    id: "memory",
    label: "Memory",
    icon: Brain,
    scope: "project",
    render: (context) => (
      <MemoryTab conversationId={context.project.coordinatorId} scope={`project:${context.project.id}`} />
    ),
  },
  {
    id: "schedules",
    label: "Schedules",
    icon: CalendarClock,
    scope: "project",
    render: (context) => <SchedulesTab slug={context.project.slug} />,
  },
  { id: "jobs", label: "Jobs", icon: Timer, render: () => <JobsView /> },
  { id: "threads", label: "All threads", icon: ListTree, render: (context) => <ThreadsView {...context} /> },
]

/** The views this pane offers: a Captain's crew in its own pane, a project's files, memory and schedules in theirs. */
export function paneViews(context: PaneContext): readonly PaneEntry[] {
  return PANE_VIEWS.filter((entry) => fits(entry, context))
}

export function paneEntry(id: string, context: PaneContext): PaneEntry | undefined {
  return paneViews(context).find((entry) => entry.id === id)
}

export function paneView(id: string, context: PaneContext): PaneEntry {
  return paneEntry(id, context) ?? OVERVIEW_VIEW
}
