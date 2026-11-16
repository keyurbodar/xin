import { For, lazy, Show, Suspense, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Brain, CalendarClock, CircleDot, HardDrive, LayoutList, ListTree, Puzzle, Timer, Users, type LucideProps } from "lucide-solid"
import { activeConversation, host, PluginBoundary, slotItems } from "../../plugins/slots.tsx"
import { Icon, isIconName } from "../ui/icon.tsx"
import { JobsView, ThreadsView } from "./bodies.tsx"
import { CrewSection, CrewView } from "./crew.tsx"
import { IssuesSection } from "./issues.tsx"
import { DriveSection, InProgressSection, NeedsYouSection, ThreadsSection, type PaneContext } from "./overview.tsx"
import { PaneSkeleton } from "../ui/skeleton.tsx"

const MemoryTab = lazy(() => import("../chat/memory.tsx").then((module) => ({ default: module.MemoryTab })))
const AutomationsTab = lazy(() => import("../chat/automations.tsx").then((module) => ({ default: module.AutomationsTab })))
const DriveView = lazy(() => import("./drive.tsx").then((module) => ({ default: module.DriveView })))
const IssueView = lazy(() => import("./issue.tsx").then((module) => ({ default: module.IssueView })))

/** Starts every lazy pane view's chunk, for the moment the pane's tabs or its + menu are about to be used. */
export function preloadPaneViews(): void {
  for (const view of [MemoryTab, AutomationsTab, DriveView, IssueView]) void view.preload()
}

const later = (body: () => JSX.Element): JSX.Element => <Suspense fallback={<PaneSkeleton rows={6} />}>{body()}</Suspense>

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
  section("issues", "Issues", IssuesSection),
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
  {
    id: "files",
    label: "Drive",
    icon: HardDrive,
    render: (context) =>
      later(() => (
        <DriveView
          conversationId={context.conversationId}
          prefer={context.captain === undefined ? { kind: "project", id: context.project.id } : { kind: "captain", id: context.captain.id }}
          projectSlug={context.project.slug}
        />
      )),
  },
  {
    id: "memory",
    label: "Memory",
    icon: Brain,
    scope: "project",
    render: (context) => later(() => <MemoryTab conversationId={context.project.coordinatorId} scope={`project:${context.project.id}`} />),
  },
  {
    id: "automations",
    label: "Automations",
    icon: CalendarClock,
    scope: "project",
    render: (context) => later(() => <AutomationsTab project={context.project} />),
  },
  { id: "jobs", label: "Jobs", icon: Timer, render: () => <JobsView /> },
  { id: "threads", label: "All threads", icon: ListTree, render: (context) => <ThreadsView {...context} /> },
]

function pluginIcon(name: string | undefined): PaneEntry["icon"] {
  if (name === undefined || !isIconName(name)) return Puzzle
  return (props) => <Icon name={name} size={Number(props.size ?? 14)} {...(props.class === undefined ? {} : { class: props.class })} />
}

/** The views this pane offers: a Captain's crew in its own pane, a project's files, memory and automations in theirs, then each enabled plugin's `pane.tab`. */
export function paneViews(context: PaneContext): readonly PaneEntry[] {
  return [
    ...PANE_VIEWS.filter((entry) => fits(entry, context)),
    ...slotItems("pane.tab")().map(
      (item): PaneEntry => ({
        id: `plugin:${item.key}`,
        label: item.title,
        icon: pluginIcon(item.icon),
        render: () => (
          <PluginBoundary plugin={item.plugin}>
            <Dynamic component={item.component} host={host} conversation={activeConversation()} />
          </PluginBoundary>
        ),
      }),
    ),
  ]
}

const issueEntries = new Map<string, PaneEntry>()

/** An issue opens as its own pane view, `issue:<id>`, outside the + menu's fixed list. One entry per id, so a home update never remounts it. */
function issueEntry(id: string): PaneEntry | undefined {
  const match = /^issue:(\d+)$/u.exec(id)
  if (match === null) return undefined
  const issue = Number(match[1])
  const entry = issueEntries.get(id) ?? {
    id,
    label: `Issue #${issue}`,
    icon: CircleDot,
    render: (context: PaneContext) => later(() => <IssueView {...context} id={issue} />),
  }
  issueEntries.set(id, entry)
  return entry
}

export function paneEntry(id: string, context: PaneContext): PaneEntry | undefined {
  return paneViews(context).find((entry) => entry.id === id) ?? issueEntry(id)
}

export function paneView(id: string, context: PaneContext): PaneEntry {
  return paneEntry(id, context) ?? OVERVIEW_VIEW
}
