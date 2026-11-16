import { ErrorBoundary, For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Brain, CalendarClock, CircleDashed, CircleDot, File, GitPullRequest, HardDrive, LayoutList, ListTree, Puzzle, Timer, Users, type LucideProps } from "lucide-solid"
import { activeConversation, host, PluginBoundary, slotItems } from "../../plugins/slots.tsx"
import { Icon, isIconName } from "../ui/icon.tsx"
import { JobsView, ThreadsView } from "./bodies.tsx"
import { CrewSection, CrewView } from "./crew.tsx"
import { DriveSection, NeedsYouSection, Overview, ThreadsSection, type PaneContext } from "./overview.tsx"
import { fileName } from "./bodies.tsx"
import { closePaneView } from "../../state/tabs.ts"
import { PaneSkeleton } from "../ui/skeleton.tsx"
import { lazyView } from "../ui/lazy-view.tsx"
import { Stopped } from "../ui/stopped.tsx"

const paneSkeleton = (): JSX.Element => <PaneSkeleton rows={6} />
const MemoryTab = lazyView(() => import("../chat/memory.tsx").then((module) => module.MemoryTab), paneSkeleton)
const AutomationsTab = lazyView(() => import("../chat/automations.tsx").then((module) => module.AutomationsTab), paneSkeleton)
const DriveView = lazyView(() => import("./drive.tsx").then((module) => module.DriveView), paneSkeleton)
const IssueView = lazyView(() => import("./issue.tsx").then((module) => module.IssueView), paneSkeleton)
const IssuesSection = lazyView(() => import("./issues.tsx").then((module) => module.IssuesSection), paneSkeleton)
const PullsView = lazyView(() => import("./issues.tsx").then((module) => module.PullsSection), paneSkeleton)
const InProgressSection = lazyView(() => import("./issues.tsx").then((module) => module.InProgressSection), () => null)
const PullsSection = lazyView(() => import("./issues.tsx").then((module) => module.PullsSection), () => null)

/** Starts every lazy pane view's chunk, for the moment the pane's tabs or its + menu are about to be used. */
export function preloadPaneViews(): void {
  for (const view of [MemoryTab, AutomationsTab, DriveView, IssueView, IssuesSection]) void view.preload()
}

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

/** Overview's sections, top to bottom. Each renders its own collapsible header and count, and a failure, such as a lazy chunk that will not load, stops only that section. */
type OverviewSection = Omit<PaneEntry, "icon">

function section(
  id: string,
  label: string,
  Body: (props: PaneContext & { label: string }) => JSX.Element,
  scope?: PaneScope,
): OverviewSection {
  return {
    id,
    label,
    render: (context) => (
      <ErrorBoundary
        fallback={(error: unknown, reset) => (
          <section aria-label={label}>
            <Stopped title={`${label} stopped`} error={error} onRetry={reset} class="py-4" />
          </section>
        )}
      >
        <Body {...context} label={label} />
      </ErrorBoundary>
    ),
    ...(scope === undefined ? {} : { scope }),
  }
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
  section("progress", "In progress", InProgressSection),
  section("threads", "Threads", ThreadsSection, "project"),
  section("pulls", "Pull requests", PullsSection),
  section("drive", "Drive", DriveSection, "project"),
]

const OVERVIEW_VIEW: PaneEntry = {
  id: "overview",
  label: "Overview",
  icon: LayoutList,
  render: (context) => (
    <Overview {...context}>
      <div class="flex flex-col gap-1">
        <For each={OVERVIEW_SECTIONS.filter((entry) => fits(entry, context))}>{(entry) => entry.render(context)}</For>
      </div>
    </Overview>
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
    render: (context) => (
      <DriveView
        conversationId={context.conversationId}
        prefer={context.captain === undefined ? { kind: "project", id: context.project.id } : { kind: "captain", id: context.captain.id }}
        projectSlug={context.project.slug}
      />
    ),
  },
  { id: "issues", label: "Issues", icon: CircleDashed, render: (context) => <IssuesSection {...context} label="Issues" /> },
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
    id: "automations",
    label: "Automations",
    icon: CalendarClock,
    scope: "project",
    render: (context) => <AutomationsTab project={context.project} />,
  },
  { id: "jobs", label: "Jobs", icon: Timer, render: () => <JobsView /> },
  { id: "threads", label: "All threads", icon: ListTree, render: (context) => <ThreadsView {...context} /> },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest, render: (context) => <PullsView {...context} label="Pull requests" /> },
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
    render: (context: PaneContext) => <IssueView {...context} id={issue} />,
  }
  issueEntries.set(id, entry)
  return entry
}

const fileEntries = new Map<string, PaneEntry>()

/** A Drive file opens as its own pane view, `file:<path>` in the project's drive; closing the file closes the tab. */
function fileEntry(id: string): PaneEntry | undefined {
  if (!id.startsWith("file:")) return undefined
  const path = id.slice("file:".length)
  const entry = fileEntries.get(id) ?? {
    id,
    label: fileName(path),
    icon: File,
    scope: "project",
    render: (context: PaneContext) => (
      <DriveView
        conversationId={context.conversationId}
        prefer={{ kind: "project", id: context.project.id }}
        projectSlug={context.project.slug}
        file={path}
        onClose={() => closePaneView(context.project.id, id)}
      />
    ),
  }
  fileEntries.set(id, entry)
  return entry
}

export function paneEntry(id: string, context: PaneContext): PaneEntry | undefined {
  return paneViews(context).find((entry) => entry.id === id) ?? issueEntry(id) ?? fileEntry(id)
}

export function paneView(id: string, context: PaneContext): PaneEntry {
  return paneEntry(id, context) ?? OVERVIEW_VIEW
}
