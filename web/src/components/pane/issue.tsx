import { createEffect, createMemo, createResource, createSignal, For, on, Show, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
import { Check, ChevronDown, GitPullRequest } from "lucide-solid"
import {
  actorName,
  assigneeName,
  commentBody,
  dueLabel,
  eventLine,
  initials,
  latestIssue,
  localDay,
  PRIORITIES,
  PRIORITY_LABEL,
  stateTone,
  timelineItems,
  type IssueEvent,
  type IssueState,
  type LinkedIssue,
  type Names,
  type Priority,
} from "../../lib/issues.ts"
import { ago } from "../../lib/format.ts"
import { firstLoad } from "../../lib/loading.ts"
import { commentOnIssue, issueScreen, issuesRev, statesRev, updateIssue } from "../../state/issues.ts"
import { showPaneView } from "../../state/tabs.ts"
import { createPaneAction, ResourceError } from "../chat/ui.tsx"
import { Button } from "../ui/button.tsx"
import { PaneSkeleton, Loading } from "../ui/skeleton.tsx"
import { MENU_CONTENT, MENU_ITEM } from "../shell/menu.ts"
import { PANE_ROW } from "./bodies.tsx"
import { AssigneeChip, PriorityMark, StateMark } from "./issue-marks.tsx"
import { issueNames, IssueRow, issueView } from "./issues.tsx"
import type { PaneContext } from "./overview.tsx"

const PICKER =
  "im-press im-hover flex h-7 items-center gap-1.5 rounded-sm px-1.5 text-sm text-ink outline-none data-[state=open]:bg-hover disabled:opacity-50"

const LABEL = "px-2 pb-1 pt-3 text-xs text-ink-3"

export function IssueView(props: PaneContext & { id: number }): JSX.Element {
  const [data, { mutate, refetch }] = createResource(
    () => props.id,
    (id) => issueScreen(id, untrack(issuesRev), untrack(statesRev)),
  )
  createEffect(on([issuesRev, statesRev], () => void refetch(), { defer: true }))
  const names = createMemo(() => issueNames(props.project))
  const action = createPaneAction()
  const stateOf = (id: string): IssueState | undefined => data.latest?.states.find((state) => state.id === id)
  const stateName = (id: string): string => stateOf(id)?.name ?? id
  const today = localDay(new Date())
  const open = (id: number): void => showPaneView(props.project.id, issueView(id))

  const change = (key: string, fields: Record<string, unknown>): void => {
    void action.run(key, async () => {
      const issue = await updateIssue(props.id, fields)
      mutate((current) =>
        current === undefined ? current : { ...current, detail: { ...current.detail, issue: latestIssue(current.detail.issue, issue) } },
      )
    })
  }

  return (
    <Loading when={firstLoad(data)} skeleton={<PaneSkeleton rows={6} />} label="Loading the issue">
      <Show when={data.error !== undefined && data.latest === undefined}>
        <ResourceError what={`issue #${props.id}`} error={data.error} onRetry={() => void refetch()} />
      </Show>
      <Show when={data.latest}>
        {(loaded) => {
          const issue = () => loaded().detail.issue
          const detail = () => loaded().detail
          const due = () => dueLabel(issue().due, today)
          return (
            <div class="flex flex-col pb-2">
              <div class="flex flex-col gap-1 px-2 pt-1">
                <span class="font-mono text-2xs text-ink-3">#{issue().id}</span>
                <h2 class="text-lg font-medium text-ink">{issue().title}</h2>
              </div>

              <dl class="mt-2 grid grid-cols-[88px_1fr] items-center gap-x-2 gap-y-0.5 px-2 text-sm">
                <dt class="text-ink-3">State</dt>
                <dd>
                  <Picker
                    label={stateName(issue().state)}
                    mark={<StateMark tone={stateTone(stateOf(issue().state))} />}
                    value={issue().state}
                    busy={action.busy() === "state"}
                    options={loaded().states.map((state) => ({
                      value: state.id,
                      label: state.name,
                      mark: <StateMark tone={stateTone(state)} />,
                    }))}
                    onPick={(state) => change("state", { state })}
                  />
                </dd>
                <dt class="text-ink-3">Priority</dt>
                <dd>
                  <Picker
                    label={PRIORITY_LABEL[issue().priority]}
                    mark={<PriorityMark priority={issue().priority} decorative />}
                    value={issue().priority}
                    busy={action.busy() === "priority"}
                    options={PRIORITIES.map((level: Priority) => ({
                      value: level,
                      label: PRIORITY_LABEL[level],
                      mark: <PriorityMark priority={level} decorative />,
                    }))}
                    onPick={(priority) => change("priority", { priority })}
                  />
                </dd>
                <dt class="text-ink-3">Due</dt>
                <dd class="flex h-7 items-center px-1.5" classList={{ "text-failed": due()?.overdue === true, "text-ink-3": due() === undefined }}>
                  {due()?.text ?? "None"}
                </dd>
                <dt class="text-ink-3">Assignees</dt>
                <dd class="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1 px-1.5">
                  <For each={issue().assignees} fallback={<span class="text-ink-3">Nobody</span>}>
                    {(assignee) => {
                      const name = assigneeName(assignee, names())
                      return (
                        <span class="flex items-center gap-1.5 text-ink">
                          <AssigneeChip names={[name]} />
                          <span class="truncate">{name}</span>
                        </span>
                      )
                    }}
                  </For>
                </dd>
                <Show when={issue().parent}>
                  {(parent) => (
                    <>
                      <dt class="text-ink-3">Parent</dt>
                      <dd>
                        <button type="button" class={`${PICKER} font-mono text-xs text-ink-2`} onClick={() => open(parent())}>
                          #{parent()}
                        </button>
                      </dd>
                    </>
                  )}
                </Show>
              </dl>
              <Show when={action.failed()}>
                {(message) => <span class="px-2 pt-1 text-xs text-failed">{message()}</span>}
              </Show>

              <span class={LABEL}>Description</span>
              <p class="whitespace-pre-wrap break-words px-2 text-sm leading-[1.55] text-ink-2">
                {issue().description === "" ? <span class="text-ink-3">No description</span> : issue().description}
              </p>

              <Show when={detail().children.length > 0}>
                <span class={LABEL}>
                  Sub-issues <span class="font-mono text-2xs text-icon">{detail().children.length}</span>
                </span>
                <For each={detail().children}>
                  {(child) => (
                    <IssueRow issue={child} state={stateOf(child.state)} names={names()} today={today} onOpen={() => open(child.id)} />
                  )}
                </For>
              </Show>

              <Links
                groups={[
                  ["Blocks", detail().links.blocks],
                  ["Blocked by", detail().links.blockedBy],
                  ["Related", detail().links.related],
                ]}
                stateOf={stateOf}
                onOpen={open}
              />

              <Show when={issue().threads.length > 0}>
                <span class={LABEL}>
                  Threads <span class="font-mono text-2xs text-icon">{issue().threads.length}</span>
                </span>
                <For each={issue().threads}>
                  {(thread, index) => (
                    <button type="button" class={PANE_ROW} onClick={() => props.onOpenThread(thread)}>
                      <span class="min-w-0 flex-1 truncate text-sm text-ink">{names().thread(thread) ?? `Thread ${thread}`}</span>
                      <Show when={index() === 0}>
                        <span class="shrink-0 text-xs text-ink-3">Owner</span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>

              <Show when={issue().prs.length > 0}>
                <span class={LABEL}>Pull requests</span>
                <For each={issue().prs}>
                  {(url) => (
                    <a href={url} target="_blank" rel="noreferrer" class={PANE_ROW}>
                      <GitPullRequest size={16} stroke-width={1.5} class="mt-0.5 shrink-0 text-merged" />
                      <span class="min-w-0 flex-1 truncate text-sm text-ink">{url.replace(/^https?:\/\//u, "")}</span>
                    </a>
                  )}
                </For>
              </Show>

              <span class={LABEL}>Activity</span>
              <Show when={detail().earlier}>
                <span class="px-2 pb-1 text-xs text-ink-3">Older activity isn’t shown.</span>
              </Show>
              <Timeline events={detail().timeline} names={names()} stateName={stateName} />
              <CommentBox id={props.id} />
            </div>
          )
        }}
      </Show>
    </Loading>
  )
}

type Option = { readonly value: string; readonly label: string; readonly mark: JSX.Element }

function Picker(props: {
  label: string
  mark: JSX.Element
  value: string
  busy: boolean
  options: readonly Option[]
  onPick: (value: string) => void
}): JSX.Element {
  return (
    <Menu.Root positioning={{ placement: "bottom-start", gutter: 4 }} lazyMount unmountOnExit>
      <Menu.Trigger class={PICKER} disabled={props.busy}>
        {props.mark}
        <span>{props.label}</span>
        <ChevronDown size={12} stroke-width={1.5} class="text-icon" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class={`${MENU_CONTENT} w-[200px]`}>
            <Menu.RadioItemGroup
              value={props.value}
              onValueChange={(details) => {
                if (details.value !== props.value) props.onPick(details.value)
              }}
            >
              <For each={props.options}>
                {(option) => (
                  <Menu.RadioItem value={option.value} class={MENU_ITEM}>
                    {option.mark}
                    <Menu.ItemText class="flex-1 truncate">{option.label}</Menu.ItemText>
                    <Menu.ItemIndicator>
                      <Check size={14} stroke-width={1.5} class="text-ink-2" />
                    </Menu.ItemIndicator>
                  </Menu.RadioItem>
                )}
              </For>
            </Menu.RadioItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

function Links(props: {
  groups: readonly (readonly [string, readonly LinkedIssue[]])[]
  stateOf: (id: string) => IssueState | undefined
  onOpen: (id: number) => void
}): JSX.Element {
  return (
    <For each={props.groups.filter(([, issues]) => issues.length > 0)}>
      {([label, issues]) => (
        <>
          <span class={LABEL}>{label}</span>
          <For each={issues}>
            {(linked) => (
              <button type="button" class={PANE_ROW} onClick={() => props.onOpen(linked.id)}>
                <StateMark tone={stateTone(props.stateOf(linked.state))} class="mt-0.5" />
                <span class="mt-px shrink-0 font-mono text-2xs text-ink-3">#{linked.id}</span>
                <span class="min-w-0 flex-1 truncate text-sm text-ink">{linked.title}</span>
              </button>
            )}
          </For>
        </>
      )}
    </For>
  )
}

function Timeline(props: { events: readonly IssueEvent[]; names: Names; stateName: (id: string) => string }): JSX.Element {
  const who = (event: IssueEvent): string => actorName(event.actor, props.names)
  return (
    <ol class="flex flex-col gap-1 px-2">
      <For each={timelineItems(props.events)}>
        {(item) => (
          <Show
            when={item.kind === "comment" ? item : undefined}
            fallback={
              <li class="flex items-baseline gap-2 py-0.5 text-xs text-ink-3">
                <span class="min-w-0 flex-1">{eventLine(item.event, who(item.event), props.stateName)}</span>
                <span class="shrink-0 font-mono text-2xs">{ago(item.event.at)}</span>
              </li>
            }
          >
            {(comment) => (
              <li class="my-1 flex flex-col gap-2 rounded-md border border-line-1 bg-card px-2.5 py-2">
                <Comment event={comment().event} who={who(comment().event)} />
                <For each={comment().replies}>
                  {(reply) => (
                    <div class="border-l border-line-2 pl-2.5">
                      <Comment event={reply} who={who(reply)} />
                    </div>
                  )}
                </For>
              </li>
            )}
          </Show>
        )}
      </For>
    </ol>
  )
}

function Comment(props: { event: IssueEvent; who: string }): JSX.Element {
  return (
    <div class="flex flex-col gap-1">
      <span class="flex items-center gap-1.5 text-xs">
        <span class="grid h-4 w-4 place-items-center rounded-full bg-muted font-mono text-[8px] font-medium text-ink-2">
          {initials(props.who)}
        </span>
        <span class="text-ink-2">{props.who}</span>
        <span class="font-mono text-2xs text-ink-3">{ago(props.event.at)}</span>
      </span>
      <p class="whitespace-pre-wrap break-words text-sm leading-[1.5] text-ink">{commentBody(props.event)}</p>
    </div>
  )
}

function CommentBox(props: { id: number }): JSX.Element {
  const [body, setBody] = createSignal("")
  const action = createPaneAction()
  const submit = (): void => {
    const text = body().trim()
    if (text === "" || action.busy() !== undefined) return
    void action.run("comment", async () => {
      await commentOnIssue(props.id, text)
      setBody("")
    })
  }
  return (
    <form
      class="mx-2 mt-2 flex flex-col gap-2 rounded-md border border-line-2 bg-card p-2 focus-within:border-line-3"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        value={body()}
        onInput={(event) => setBody(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        rows={3}
        maxLength={20_000}
        placeholder="Leave a comment"
        aria-label="Comment"
        class="w-full resize-none bg-transparent text-sm text-ink outline-none placeholder:text-placeholder"
      />
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-xs text-failed">{action.failed()}</span>
        <Button type="submit" variant="primary" size="sm" disabled={body().trim() === "" || action.busy() !== undefined}>
          {action.busy() === undefined ? "Comment" : "Sending"}
        </Button>
      </div>
    </form>
  )
}
