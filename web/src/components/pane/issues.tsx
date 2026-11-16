import { createMemo, createResource, createSignal, createUniqueId, For, Show, type Component, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Archive, ArrowUpRight, GitPullRequest, MessagesSquare, Plus } from "lucide-solid"
import {
  assigneeName,
  closedGroups,
  issueScope,
  dueLabel,
  localDay,
  openGroups,
  activeIssues,
  linkedPulls,
  pullLabel,
  stateTone,
  type IssueGroup,
  type IssueState,
  type IssueSummary,
  type Names,
} from "../../lib/issues.ts"
import { projectThreads, type ProjectSummary } from "../../state/home.ts"
import { issuesRev, projectIssueList, statesRev } from "../../state/issues.ts"
import { ago } from "../../lib/format.ts"
import { homeCaptains } from "../../state/captains.ts"
import { PANE_ROW } from "./bodies.tsx"
import { showPaneView } from "../../state/tabs.ts"
import { ICON_BUTTON } from "../shell/menu.ts"
import { loadOnIntent } from "../../lib/ui-sdk-lazy.ts"
import { AssigneeChip, PriorityMark, StateMark } from "./issue-marks.tsx"
import { createPaneIssues, Section, type PaneContext } from "./overview.tsx"

export const mintCommandId = (): string => crypto.randomUUID()

export function issueView(id: number): string {
  return `issue:${id}`
}

export function issueNames(project: ProjectSummary): Names {
  const titles = new Map(projectThreads(project).map((thread) => [thread.id, thread.title]))
  return {
    thread: (id) => titles.get(id),
    captain: (id) => homeCaptains().find((captain) => captain.coordinatorId === id)?.name ?? (id === project.coordinatorId ? project.name : undefined),
  }
}

function issueProjectId(context: PaneContext): string {
  return issueScope(context.project, context.captain)
}

export function IssuesSection(props: PaneContext & { label: string }): JSX.Element {
  const [data] = createResource(
    () => [issueProjectId(props), issuesRev(), statesRev()] as const,
    ([project, rev, states]) => projectIssueList(project, false, rev, states),
  )
  const [showClosed, setShowClosed] = createSignal(false)
  const [closed] = createResource(
    () => (showClosed() ? ([issueProjectId(props), issuesRev(), statesRev()] as const) : false),
    ([project, rev, states]) => projectIssueList(project, true, rev, states),
  )
  const groups = createMemo(() => {
    const loaded = data.latest
    return loaded === undefined ? [] : openGroups(loaded.states, loaded.issues)
  })
  const closedRows = createMemo(() => {
    const loaded = closed.latest
    return !showClosed() || loaded === undefined ? [] : closedGroups(loaded.states, loaded.issues)
  })
  const total = (): number => groups().reduce((sum, group) => sum + group.issues.length, 0)
  const names = createMemo(() => issueNames(props.project))
  const today = localDay(new Date())
  const empty = (): string => {
    if (data.error !== undefined && data.latest === undefined) return "Couldn’t load issues"
    return data.latest === undefined ? "Loading issues" : "No open issues"
  }

  return (
    <Section
      label={props.label}
      count={total()}
      action={
        <>
          <ui-toggle on:pressedchange={(event) => setShowClosed(event.detail.value)}>
            <button
              type="button"
              class={`${ICON_BUTTON} aria-pressed:bg-hover aria-pressed:text-ink`}
              aria-label="Closed issues"
              aria-pressed="false"
              title={showClosed() ? "Hide closed issues" : "Show closed issues"}
              {...loadOnIntent("toggle")}
            >
              <ui-toggle-icon class="contents">
                <Archive size={14} stroke-width={1.5} />
              </ui-toggle-icon>
            </button>
          </ui-toggle>
          <NewIssue project={props.project} projectId={issueProjectId(props)} states={data.latest?.states ?? []} />
        </>
      }
    >
      <For each={groups()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">{empty()}</span>}>
        {(group) => <IssueGroupRows group={group} project={props.project} names={names()} today={today} />}
      </For>
      <Show when={showClosed()}>
        <For
          each={closedRows()}
          fallback={
            <span class="px-2 py-1.5 text-sm text-ink-3">
              {closed.error !== undefined ? "Couldn’t load closed issues" : closed.latest === undefined ? "Loading closed issues" : "No closed issues"}
            </span>
          }
        >
          {(group) => <IssueGroupRows group={group} project={props.project} names={names()} today={today} />}
        </For>
      </Show>
    </Section>
  )
}

/** Issues someone is working on, with a side column of priority over age. */
export function InProgressSection(props: PaneContext & { label: string }): JSX.Element {
  const { issues } = createPaneIssues(() => props)
  const rows = () => {
    const loaded = issues()
    return loaded === undefined ? [] : activeIssues(loaded.states, loaded.issues)
  }
  const stateOf = (id: string): IssueState | undefined => issues()?.states.find((state) => state.id === id)
  const names = createMemo(() => issueNames(props.project))
  return (
    <Section
      label={props.label}
      count={rows().length}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="All issues" onClick={() => showPaneView(props.project.id, "issues")}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <For each={rows()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">{issues() === undefined ? "Loading issues" : "Nothing in progress"}</span>}>
        {(issue) => (
          <button type="button" onClick={() => showPaneView(props.project.id, issueView(issue.id))} class={PANE_ROW}>
            <StateMark tone={stateTone(stateOf(issue.state))} label={stateOf(issue.state)?.name} class="mt-0.5" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-ink">{issue.title}</span>
              <span class="block truncate text-xs text-ink-3">
                <span class="font-mono text-2xs">#{issue.id}</span>
                <Show when={issue.assignees[0]}>{(first) => <> with {assigneeName(first(), names())}</>}</Show>
              </span>
            </span>
            <span class="flex shrink-0 flex-col items-end gap-0.5 pt-0.5">
              <PriorityMark priority={issue.priority} />
              <span class="font-mono text-2xs text-ink-3">{ago(issue.updatedAt)}</span>
            </span>
          </button>
        )}
      </For>
    </Section>
  )
}

/** Pull requests linked from the pane's open issues, once each, with the issue that links them. */
export function PullsSection(props: PaneContext & { label: string }): JSX.Element {
  const { issues } = createPaneIssues(() => props)
  const pulls = () => linkedPulls(issues()?.issues ?? [])
  return (
    <Section
      label={props.label}
      count={pulls().length}
      action={
        <button type="button" class={ICON_BUTTON} aria-label="All pull requests" onClick={() => showPaneView(props.project.id, "pulls")}>
          <ArrowUpRight size={14} stroke-width={1.5} />
        </button>
      }
    >
      <For each={pulls()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">No linked pull requests</span>}>
        {(pull) => (
          <a href={pull.url} target="_blank" rel="noreferrer" class={PANE_ROW}>
            <GitPullRequest size={16} stroke-width={1.5} class="mt-0.5 shrink-0 text-merged" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-ink">{pullLabel(pull.url)}</span>
              <span class="block truncate text-xs text-ink-3">{pull.issues.map((issue) => issue.title).join(", ")}</span>
            </span>
          </a>
        )}
      </For>
    </Section>
  )
}

function IssueGroupRows(props: { group: IssueGroup; project: ProjectSummary; names: Names; today: string }): JSX.Element {
  return (
    <div class="flex flex-col">
      <span class="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-mini font-title text-ink-3">
        {props.group.state.name}
        <span class="font-mono text-mini font-normal text-icon">{props.group.issues.length}</span>
      </span>
      <For each={props.group.issues}>
        {(issue) => (
          <IssueRow
            issue={issue}
            state={props.group.state}
            names={props.names}
            today={props.today}
            onOpen={() => showPaneView(props.project.id, issueView(issue.id))}
          />
        )}
      </For>
    </div>
  )
}

export function IssueRow(props: {
  issue: IssueSummary
  state: IssueState | undefined
  names: Names
  today: string
  onOpen: () => void
}): JSX.Element {
  const due = () => dueLabel(props.issue.due, props.today)
  return (
    <button type="button" data-issue={props.issue.id} onClick={() => props.onOpen()} class={ISSUE_ROW}>
      <StateMark tone={stateTone(props.state)} label={props.state?.name} />
      <span class="w-8 shrink-0 font-mono text-mini text-ink-3">#{props.issue.id}</span>
      <span class="min-w-0 flex-1 truncate text-small font-title text-ink">{props.issue.title}</span>
      <Show when={props.issue.threads.length > 0}>
        <span class="flex shrink-0 items-center gap-1 text-ink-3" title={`${props.issue.threads.length} linked threads`}>
          <MessagesSquare size={12} stroke-width={1.5} />
          <span class="font-mono text-mini">{props.issue.threads.length}</span>
        </span>
      </Show>
      <Show when={due()}>
        {(label) => (
          <span
            class="shrink-0 text-mini"
            classList={{ "text-failed": label().overdue, "text-ink-3": !label().overdue }}
            title={`${label().overdue ? "Overdue" : "Due"} ${label().text}`}
          >
            {label().text}
          </span>
        )}
      </Show>
      <PriorityMark priority={props.issue.priority} />
      <AssigneeChip names={props.issue.assignees.map((assignee) => assigneeName(assignee, props.names))} />
    </button>
  )
}

const ISSUE_ROW =
  "im-hover flex h-[var(--h-list-row)] w-full shrink-0 items-center gap-2 rounded-sm px-2 text-left outline-none focus-visible:bg-secondary focus-visible:shadow-[inset_2px_0_0_var(--color-primary)]"

export type NewIssueProps = { readonly project: ProjectSummary; readonly projectId: string; readonly states: readonly IssueState[] }

/**
 * The + stays a plain trigger until first intent; then the popover's module and elements load, the popover renders
 * beside it under the same id, and a click that came first is replayed.
 */
function NewIssue(props: NewIssueProps): JSX.Element {
  const id = `new-issue-${createUniqueId()}`
  const [popover, setPopover] = createSignal<Component<NewIssueProps & { id: string }>>()
  let loading: Promise<void> | undefined
  const load = (): Promise<void> =>
    (loading ??= import("./new-issue.tsx").then(
      (module) => void setPopover(() => module.NewIssuePopover),
      (error: unknown) => {
        loading = undefined
        throw error
      },
    ))
  const warm = (): void => void load().catch(() => undefined)
  return (
    <>
      <ui-popover-trigger attr:for={id}>
        <button
          type="button"
          class={`${ICON_BUTTON} aria-expanded:bg-hover aria-expanded:text-ink`}
          aria-label="New issue"
          title="New issue"
          onPointerEnter={warm}
          onPointerDown={warm}
          onFocus={warm}
          onClick={(event) => {
            if (popover() !== undefined) return
            const button = event.currentTarget
            void load().then(
              () => requestAnimationFrame(() => button.click()),
              () => undefined,
            )
          }}
        >
          <Plus size={14} stroke-width={1.5} />
        </button>
      </ui-popover-trigger>
      <Show when={popover()}>{(view) => <Dynamic component={view()} id={id} {...props} />}</Show>
    </>
  )
}
