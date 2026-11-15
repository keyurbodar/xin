import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Popover } from "@ark-ui/solid/popover"
import { MessagesSquare, Plus } from "lucide-solid"
import {
  assigneeName,
  dueLabel,
  localDay,
  newIssueArgs,
  openGroups,
  PRIORITIES,
  PRIORITY_LABEL,
  stateTone,
  type IssueState,
  type IssueSummary,
  type Names,
  type Priority,
} from "../../lib/issues.ts"
import { homeIssuesRev, projectThreads, type ProjectSummary } from "../../state/home.ts"
import { createIssue, issueStates, openProjectIssues } from "../../state/issues.ts"
import { showPaneView } from "../../state/tabs.ts"
import { createPaneAction } from "../chat/ui.tsx"
import { Button } from "../ui/button.tsx"
import { ICON_BUTTON, MENU_CONTENT } from "../shell/menu.ts"
import { PANE_ROW } from "./bodies.tsx"
import { AssigneeChip, PriorityMark, StateMark } from "./issue-marks.tsx"
import { Section, type PaneContext } from "./overview.tsx"

export function issueView(id: number): string {
  return `issue:${id}`
}

export function issueNames(project: ProjectSummary): Names {
  const titles = new Map(projectThreads(project).map((thread) => [thread.id, thread.title]))
  return {
    thread: (id) => titles.get(id),
    captain: (id) => (id === project.coordinatorId ? project.name : undefined),
  }
}

/** Re-keys on the home's issue revision, so the list reads once on open and once per change, never on a timer. */
function revKey(project: () => string): () => string {
  return () => `${homeIssuesRev()}:${project()}`
}

const afterRev = (key: string): string => key.slice(key.indexOf(":") + 1)

export function IssuesSection(props: PaneContext & { label: string }): JSX.Element {
  const [data] = createResource(revKey(() => props.project.id), async (key) => {
    const [states, issues] = await Promise.all([issueStates(), openProjectIssues(afterRev(key))])
    return { states, issues }
  })
  const groups = createMemo(() => {
    const loaded = data.latest
    return loaded === undefined ? [] : openGroups(loaded.states, loaded.issues)
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
      action={<NewIssue project={props.project} states={data.latest?.states ?? []} />}
    >
      <For each={groups()} fallback={<span class="px-2 py-1.5 text-sm text-ink-3">{empty()}</span>}>
        {(group) => (
          <div class="flex flex-col">
            <span class="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-xs text-ink-3">
              {group.state.name}
              <span class="font-mono text-2xs text-icon">{group.issues.length}</span>
            </span>
            <For each={group.issues}>
              {(issue) => (
                <IssueRow
                  issue={issue}
                  state={group.state}
                  names={names()}
                  today={today}
                  onOpen={() => showPaneView(props.project.id, issueView(issue.id))}
                />
              )}
            </For>
          </div>
        )}
      </For>
    </Section>
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
    <button type="button" onClick={() => props.onOpen()} class={PANE_ROW}>
      <StateMark tone={stateTone(props.state)} label={props.state?.name} class="mt-0.5" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-ink">{props.issue.title}</span>
        <span class="flex items-center gap-1.5 text-xs text-ink-3">
          <span class="font-mono text-2xs">#{props.issue.id}</span>
          <Show when={due()}>
            {(label) => (
              <span classList={{ "text-failed": label().overdue }}>
                · {label().overdue ? "Overdue " : "Due "}
                {label().text}
              </span>
            )}
          </Show>
          <Show when={props.issue.threads.length > 0}>
            <span class="flex items-center gap-1" title={`${props.issue.threads.length} linked threads`}>
              · <MessagesSquare size={12} stroke-width={1.5} />
              <span class="font-mono text-2xs">{props.issue.threads.length}</span>
            </span>
          </Show>
        </span>
      </span>
      <span class="mt-0.5 flex shrink-0 items-center gap-2">
        <PriorityMark priority={props.issue.priority} />
        <AssigneeChip names={props.issue.assignees.map((assignee) => assigneeName(assignee, props.names))} />
      </span>
    </button>
  )
}

const CHIP =
  "im-press flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-primary-soft"

function chipClass(on: boolean): string {
  return `${CHIP} ${on ? "border-line-3 bg-hover text-ink" : "border-line-1 hover:bg-secondary"}`
}

/** Title first; priority and state are optional and fall back to the contract's defaults (Normal, the default open state). */
function NewIssue(props: { project: ProjectSummary; states: readonly IssueState[] }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const [priority, setPriority] = createSignal<Priority>()
  const [state, setState] = createSignal<string>()
  const action = createPaneAction()
  const args = () =>
    newIssueArgs({
      title: title(),
      project: props.project.id,
      priority: priority(),
      state: state(),
    })
  const reset = (): void => {
    setTitle("")
    setPriority(undefined)
    setState(undefined)
  }
  const submit = (): void => {
    const body = args()
    if (body === undefined || action.busy() !== undefined) return
    void action.run("create", async () => {
      await createIssue(body)
      reset()
      setOpen(false)
    })
  }

  return (
    <Popover.Root
      open={open()}
      onOpenChange={(details) => setOpen(details.open)}
      lazyMount
      unmountOnExit
      positioning={{ placement: "bottom-end", gutter: 6 }}
    >
      <Popover.Trigger class={ICON_BUTTON} aria-label="New issue">
        <Plus size={14} stroke-width={1.5} />
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content class={`${MENU_CONTENT} w-[320px] p-0`}>
            <form
              class="flex flex-col"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <div class="border-b border-line-1 px-3 pb-2 pt-2.5">
                <span class="text-xs text-ink-3">New issue in {props.project.name}</span>
                <input
                  autofocus
                  value={title()}
                  onInput={(event) => setTitle(event.currentTarget.value)}
                  placeholder="Issue title"
                  aria-label="Issue title"
                  maxLength={300}
                  class="mt-1 h-6 w-full bg-transparent text-sm text-ink outline-none placeholder:text-placeholder"
                />
              </div>
              <div class="flex flex-col gap-2 px-3 py-2.5">
                <span class="text-xs text-ink-3">Priority</span>
                <div class="flex flex-wrap gap-1">
                  <For each={PRIORITIES}>
                    {(level) => (
                      <button
                        type="button"
                        aria-pressed={priority() === level}
                        class={chipClass(priority() === level)}
                        onClick={() => setPriority(priority() === level ? undefined : level)}
                      >
                        <PriorityMark priority={level} decorative />
                        {PRIORITY_LABEL[level]}
                      </button>
                    )}
                  </For>
                </div>
                <Show when={props.states.length > 0}>
                  <span class="pt-1 text-xs text-ink-3">State</span>
                  <div class="flex flex-wrap gap-1">
                    <For each={props.states.filter((entry) => !entry.closed)}>
                      {(entry) => (
                        <button
                          type="button"
                          aria-pressed={state() === entry.id}
                          class={chipClass(state() === entry.id)}
                          onClick={() => setState(state() === entry.id ? undefined : entry.id)}
                        >
                          <StateMark tone={stateTone(entry)} />
                          {entry.name}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <div class="flex items-center gap-2 border-t border-line-1 px-3 py-2">
                <span class="min-w-0 flex-1 truncate text-xs text-failed">{action.failed()}</span>
                <Button type="submit" variant="primary" size="sm" disabled={args() === undefined || action.busy() !== undefined}>
                  {action.busy() === undefined ? "Create" : "Creating"}
                </Button>
              </div>
            </form>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  )
}
