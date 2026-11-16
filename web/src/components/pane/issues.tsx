import "@ui-sdk/web/popover"
import "@ui-sdk/web/radio"
import "@ui-sdk/web/select"
import "@ui-sdk/web/toggle"
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { Archive, Check, ChevronDown, MessagesSquare, Plus, X } from "lucide-solid"
import {
  assigneeName,
  closedGroups,
  issueScope,
  dueLabel,
  localDay,
  newIssueArgs,
  createCommandIds,
  openGroups,
  PRIORITIES,
  PRIORITY_LABEL,
  stateTone,
  type IssueGroup,
  type IssueState,
  type IssueSummary,
  type Names,
  type Priority,
} from "../../lib/issues.ts"
import { projectThreads, type ProjectSummary } from "../../state/home.ts"
import { createIssue, issuesRev, projectIssueList, statesRev } from "../../state/issues.ts"
import { homeCaptains } from "../../state/captains.ts"
import { showPaneView } from "../../state/tabs.ts"
import { createPaneAction } from "../chat/ui.tsx"
import { Button } from "../ui/button.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM } from "../ui/surface.ts"
import { AssigneeChip, PriorityMark, StateMark } from "./issue-marks.tsx"
import { Section, type PaneContext } from "./overview.tsx"

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
          <ui-toggle prop:pressed={showClosed()} on:pressedchange={(event) => setShowClosed(event.detail.value)}>
            <button
              type="button"
              class={`${ICON_BUTTON} aria-pressed:bg-hover aria-pressed:text-ink`}
              aria-label="Closed issues"
              title={showClosed() ? "Hide closed issues" : "Show closed issues"}
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

const SEGMENT =
  "im-press im-hover flex h-7 cursor-default items-center gap-1.5 rounded-sm border border-line-1 px-2 text-xs text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-primary-soft data-[checked]:border-line-3 data-[checked]:bg-hover data-[checked]:text-ink"

const FIELD_LABEL = "text-mini font-title text-ink-3"

/** Title first; priority and state are optional and fall back to the contract's defaults (Normal, the default open state). */
function NewIssue(props: { project: ProjectSummary; projectId: string; states: readonly IssueState[] }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const content = createOverlayMount(open)
  const [title, setTitle] = createSignal("")
  const [priority, setPriority] = createSignal<Priority>()
  let pressedFrom: Priority | undefined
  const [state, setState] = createSignal<string>()
  const action = createPaneAction()
  const openStates = () => props.states.filter((entry) => !entry.closed)
  const args = () =>
    newIssueArgs({
      title: title(),
      project: props.projectId,
      priority: priority(),
      state: state(),
    })
  const reset = (): void => {
    setTitle("")
    setPriority(undefined)
    setState(undefined)
  }
  const ids = createCommandIds(mintCommandId)
  const submit = (): void => {
    const body = args()
    if (body === undefined || action.busy() !== undefined) return
    void action.run("create", async () => {
      try {
        await createIssue(body, ids.idFor(body))
      } catch (problem) {
        ids.settle(problem)
        throw problem
      }
      ids.settle(undefined)
      reset()
      setOpen(false)
    })
  }

  return (
    <ui-popover
      prop:open={open()}
      on:openchange={(event) => {
        event.preventDefault()
        const next = event.detail.value
        queueMicrotask(() => setOpen(next))
      }}
      on:openchangecomplete={content.settle}
    >
      <ui-popover-trigger>
        <button type="button" class={`${ICON_BUTTON} aria-expanded:bg-hover aria-expanded:text-ink`} aria-label="New issue" title="New issue">
          <Plus size={14} stroke-width={1.5} />
        </button>
      </ui-popover-trigger>
      <ui-popover-content side="bottom" align="end" side-offset="6" class={`${POPUP} w-[320px] p-0`}>
        <Show when={content.mounted()}>
          <ui-popover-title class="sr-only">New issue</ui-popover-title>
          <form
            class="flex flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <div class="border-b border-line-1 px-3 pb-2 pt-2.5">
              <span class="text-mini text-ink-3">New issue in {props.project.name}</span>
              <input
                autofocus
                value={title()}
                onInput={(event) => setTitle(event.currentTarget.value)}
                placeholder="Issue title"
                aria-label="Issue title"
                maxLength={300}
                class="mt-1 h-6 w-full bg-transparent text-body font-title text-ink outline-none placeholder:font-normal placeholder:text-placeholder"
              />
            </div>
            <div class="flex flex-col gap-2 px-3 py-2.5">
              <span id="new-issue-priority" class={FIELD_LABEL}>
                Priority
              </span>
              <ui-radio-group
                aria-labelledby="new-issue-priority"
                prop:value={priority() ?? null}
                on:valuechange={(event) => {
                  const level = PRIORITIES.find((entry) => entry === event.detail.value)
                  if (level !== undefined) setPriority(level)
                }}
                oncapture:click={() => {
                  pressedFrom = priority()
                }}
                on:click={(event) => {
                  const level = event.target instanceof Element ? event.target.closest("ui-radio")?.getAttribute("value") : undefined
                  if (level !== undefined && level === pressedFrom) setPriority(undefined)
                }}
                class="flex flex-wrap gap-1"
              >
                <For each={PRIORITIES}>
                  {(level) => (
                    <ui-radio value={level} class={SEGMENT}>
                      <PriorityMark priority={level} decorative />
                      {PRIORITY_LABEL[level]}
                    </ui-radio>
                  )}
                </For>
              </ui-radio-group>
              <Show when={openStates().length > 0}>
                <ui-select
                  class="flex flex-col gap-2 pt-1"
                  placeholder="Default"
                  prop:value={state() ?? null}
                  on:valuechange={(event) => {
                    const value = event.detail.value
                    setState(typeof value === "string" ? value : undefined)
                  }}
                >
                  <ui-select-label class={FIELD_LABEL}>State</ui-select-label>
                  <div class="flex items-center gap-1">
                    <ui-select-trigger class="block min-w-0 flex-1">
                      <button
                        type="button"
                        class="im-hover flex h-7 w-full items-center gap-2 rounded-sm border border-line-1 px-2 text-left text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary-soft aria-expanded:bg-hover"
                      >
                        <Show when={openStates().find((entry) => entry.id === state())}>
                          {(chosen) => <StateMark tone={stateTone(chosen())} />}
                        </Show>
                        <ui-select-value class="min-w-0 flex-1 truncate data-[placeholder]:text-ink-3" />
                        <ChevronDown size={12} stroke-width={1.5} class="shrink-0 text-icon" />
                      </button>
                    </ui-select-trigger>
                    <ui-select-clear>
                      <button type="button" class={ICON_BUTTON} aria-label="Use the default state" title="Use the default state">
                        <X size={14} stroke-width={1.5} />
                      </button>
                    </ui-select-clear>
                  </div>
                  <ui-select-content side-offset="4" class={`${POPUP} w-[var(--anchor-width)]`}>
                    <For each={openStates()}>
                      {(entry) => (
                        <ui-select-item value={entry.id} label={entry.name} class={POPUP_ITEM}>
                          <StateMark tone={stateTone(entry)} />
                          <ui-select-item-text class="min-w-0 flex-1 truncate">{entry.name}</ui-select-item-text>
                          <ui-select-item-indicator class="text-ink-2">
                            <Check size={14} stroke-width={1.5} />
                          </ui-select-item-indicator>
                        </ui-select-item>
                      )}
                    </For>
                  </ui-select-content>
                </ui-select>
              </Show>
            </div>
            <div class="flex items-center gap-2 border-t border-line-1 px-3 py-2">
              <span class="min-w-0 flex-1 truncate text-xs text-failed">{action.failed()}</span>
              <Button type="submit" variant="primary" size="sm" disabled={args() === undefined || action.busy() !== undefined}>
                {action.busy() === undefined ? "Create" : "Creating"}
              </Button>
            </div>
          </form>
        </Show>
      </ui-popover-content>
    </ui-popover>
  )
}
