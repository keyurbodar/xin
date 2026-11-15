import { For, type JSX } from "solid-js"
import { Brain, CalendarClock, HardDrive, LayoutList, ListTree, Timer, type LucideProps } from "lucide-solid"
import { MemoryTab } from "../chat/memory.tsx"
import { SchedulesTab } from "../chat/schedules.tsx"
import { JobsView, ThreadsView } from "./bodies.tsx"
import { DriveView } from "./drive.tsx"
import { DriveSection, InProgressSection, NeedsYouSection, ThreadsSection, type PaneContext } from "./overview.tsx"

export type { PaneContext }

export type PaneEntry = {
  readonly id: string
  readonly label: string
  readonly icon: (props: LucideProps) => JSX.Element
  readonly render: (context: PaneContext) => JSX.Element
}

/** Overview's sections, top to bottom. Each renders its own collapsible header and count. */
type OverviewSection = Omit<PaneEntry, "icon">

function section(
  id: string,
  label: string,
  Body: (props: PaneContext & { label: string }) => JSX.Element,
): OverviewSection {
  return { id, label, render: (context) => <Body {...context} label={label} /> }
}

export const OVERVIEW_SECTIONS: readonly OverviewSection[] = [
  section("needs", "Needs you", NeedsYouSection),
  section("progress", "In progress", InProgressSection),
  section("threads", "Threads", ThreadsSection),
  section("drive", "Drive", DriveSection),
]

const OVERVIEW_VIEW: PaneEntry = {
  id: "overview",
  label: "Overview",
  icon: LayoutList,
  render: (context) => (
    <div class="flex flex-col gap-1">
      <For each={OVERVIEW_SECTIONS}>{(section) => section.render(context)}</For>
    </div>
  ),
}

/** Every view the right pane can show: its tabs, the + menu, and the body each one renders. */
export const PANE_VIEWS: readonly PaneEntry[] = [
  OVERVIEW_VIEW,
  {
    id: "files",
    label: "Drive",
    icon: HardDrive,
    render: (context) => <DriveView conversationId={context.conversationId} projectId={context.project.id} projectSlug={context.project.slug} />,
  },
  {
    id: "memory",
    label: "Memory",
    icon: Brain,
    render: (context) => (
      <MemoryTab conversationId={context.project.coordinatorId} scope={`project:${context.project.id}`} />
    ),
  },
  { id: "schedules", label: "Schedules", icon: CalendarClock, render: (context) => <SchedulesTab slug={context.project.slug} /> },
  { id: "jobs", label: "Jobs", icon: Timer, render: () => <JobsView /> },
  { id: "threads", label: "All threads", icon: ListTree, render: (context) => <ThreadsView {...context} /> },
]

export function paneEntry(id: string): PaneEntry | undefined {
  return PANE_VIEWS.find((entry) => entry.id === id)
}

export function paneView(id: string): PaneEntry {
  return paneEntry(id) ?? OVERVIEW_VIEW
}
