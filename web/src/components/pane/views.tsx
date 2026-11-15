import { For, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Brain, CalendarClock, Folder, LayoutList, ListTree, Puzzle, Timer, type LucideProps } from "lucide-solid"
import { activeConversation, host, slotItems } from "../../plugins/slots.tsx"
import { Icon, isIconName } from "../ui/icon.tsx"
import { MemoryTab } from "../chat/memory.tsx"
import { AutomationsTab } from "../chat/automations.tsx"
import { FilesView, JobsView, ThreadsView } from "./bodies.tsx"
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
  { id: "files", label: "Files", icon: Folder, render: (context) => <FilesView slug={context.project.slug} /> },
  {
    id: "memory",
    label: "Memory",
    icon: Brain,
    render: (context) => (
      <MemoryTab conversationId={context.project.coordinatorId} scope={`project:${context.project.id}`} />
    ),
  },
  { id: "automations", label: "Automations", icon: CalendarClock, render: (context) => <AutomationsTab project={context.project} /> },
  { id: "jobs", label: "Jobs", icon: Timer, render: () => <JobsView /> },
  { id: "threads", label: "All threads", icon: ListTree, render: (context) => <ThreadsView {...context} /> },
]

function pluginIcon(name: string | undefined): PaneEntry["icon"] {
  if (name === undefined || !isIconName(name)) return Puzzle
  return (props) => <Icon name={name} size={Number(props.size ?? 14)} {...(props.class === undefined ? {} : { class: props.class })} />
}

/** The built-in views, then each enabled plugin's `pane.tab`. */
export function paneViews(): readonly PaneEntry[] {
  return [
    ...PANE_VIEWS,
    ...slotItems("pane.tab")().map(
      (item): PaneEntry => ({
        id: `plugin:${item.key}`,
        label: item.title,
        icon: pluginIcon(item.icon),
        render: () => <Dynamic component={item.component} host={host} conversation={activeConversation()} />,
      }),
    ),
  ]
}

export function paneEntry(id: string): PaneEntry | undefined {
  return paneViews().find((entry) => entry.id === id)
}

export function paneView(id: string): PaneEntry {
  return paneEntry(id) ?? OVERVIEW_VIEW
}
