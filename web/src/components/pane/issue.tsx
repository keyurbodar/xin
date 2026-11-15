import { createEffect, createMemo, createResource, createSignal, For, on, Show, untrack, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
import { Check, ChevronDown, GitPullRequest, X } from "lucide-solid"
import {
  actorName,
  assigneeName,
  assigneesEdit,
  descriptionEdit,
  dueEdit,
  issueScope,
  LINK_LABEL,
  linkArgs,
  createCommandIds,
  assignableCandidates,
  threadPlace,
  type ThreadHome,
  type ThreadPlace,
  titleEdit,
  withHead,
  withOlder,
  type Candidate,
  type Edit,
  type Issue,
  type LinkKind,
  type TimelinePages,
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
import { homeCaptains } from "../../state/captains.ts"
import { homeProjects, projectThreads, type ProjectSummary } from "../../state/home.ts"
import { commentOnIssue, issueDetail, issueScreen, issuesRev, linkIssue, statesRev, updateIssue } from "../../state/issues.ts"
import { navigate } from "../../lib/router.ts"
import { openThreadTab, showPaneView } from "../../state/tabs.ts"
import { createPaneAction, ResourceError } from "../chat/ui.tsx"
import { Button } from "../ui/button.tsx"
import { PaneSkeleton, Loading } from "../ui/skeleton.tsx"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM } from "../shell/menu.ts"
import { PANE_ROW } from "./bodies.tsx"
import { AddLink, AssigneesField, createFieldAction, DescriptionField, DueField, FieldError, TitleField } from "./issue-edit.tsx"
import { PriorityMark, StateMark } from "./issue-marks.tsx"
import { issueNames, IssueRow, issueView, mintCommandId } from "./issues.tsx"
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
  const [pages, setPages] = createSignal<TimelinePages>()
  createEffect(() => {
    const head = data.latest?.detail
    if (head !== undefined) setPages((current) => withHead(untrack(() => current), head))
  })
  const names = createMemo(() => issueNames(props.project))
  const candidates = createMemo(() => {
    const scope = issueScope(props.project, props.captain)
    const project = homeProjects().find((entry) => entry.id === scope) ?? props.project
    return assignableCandidates(project, projectThreads(project), homeCaptains())
  })
  const action = createFieldAction()
  const stateOf = (id: string): IssueState | undefined => data.latest?.states.find((state) => state.id === id)
  const stateName = (id: string): string => stateOf(id)?.name ?? id
  const today = localDay(new Date())
  const open = (id: number): void => showPaneView(props.project.id, issueView(id))

  const keep = (issue: Issue): void => {
    mutate((current) =>
      current === undefined ? current : { ...current, detail: { ...current.detail, issue: latestIssue(current.detail.issue, issue) } },
    )
  }
  const write = async (fields: Record<string, unknown>): Promise<void> => keep(await updateIssue(props.id, fields))
  const edit = (key: string, change: Edit): Promise<boolean> => action.send(key, change, write)
  const link = (kind: LinkKind, other: number, on: boolean): Promise<boolean> => {
    const detail = data.latest?.detail
    if (detail === undefined) return Promise.resolve(false)
    if (!on) return action.run("links", async () => keep(await linkIssue({ id: props.id, kind, other }, false)))
    const args = linkArgs(props.id, kind, other, detail.links)
    if (args.kind === "invalid") return action.send("links", args, write)
    return action.run("links", async () => keep(await linkIssue(args.args, true)))
  }
  const loadOlder = (): void => {
    const current = pages()
    if (current?.cursor === null || current === undefined) return
    void action.run("older", async () => {
      const older = await issueDetail(props.id, current.cursor ?? undefined)
      setPages((latest) => (latest === undefined ? latest : withOlder(latest, older)))
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
                <TitleField
                  value={issue().title}
                  busy={action.busy() === "title"}
                  onSave={(draft) => edit("title", titleEdit(issue().title, draft))}
                />
                <FieldError message={action.error("title")} />
              </div>

              <dl class="mt-2 grid grid-cols-[88px_1fr] items-start gap-x-2 gap-y-0.5 px-2 text-sm">
                <dt class="flex h-7 items-center text-ink-3">State</dt>
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
                    onPick={(state) => void edit("state", { kind: "send", fields: { state } })}
                  />
                  <FieldError message={action.error("state")} />
                </dd>
                <dt class="flex h-7 items-center text-ink-3">Priority</dt>
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
                    onPick={(priority) => void edit("priority", { kind: "send", fields: { priority } })}
                  />
                  <FieldError message={action.error("priority")} />
                </dd>
                <dt class="flex h-7 items-center text-ink-3">Due</dt>
                <dd>
                  <DueField
                    value={issue().due}
                    label={due()?.text}
                    overdue={due()?.overdue === true}
                    busy={action.busy() === "due"}
                    onSave={(value) => edit("due", dueEdit(issue().due, value))}
                  />
                  <FieldError message={action.error("due")} />
                </dd>
                <dt class="flex h-7 items-center text-ink-3">Assignees</dt>
                <dd>
                  <AssigneesField
                    assignees={issue().assignees}
                    name={(assignee) => assigneeName(assignee, names())}
                    candidates={candidates()}
                    busy={action.busy() === "assignees"}
                    onAdd={(add) => edit("assignees", assigneesEdit(issue().assignees, { add }))}
                    onRemove={(remove) => edit("assignees", assigneesEdit(issue().assignees, { remove }))}
                  />
                  <FieldError message={action.error("assignees")} />
                </dd>
                <Show when={issue().parent}>
                  {(parent) => (
                    <>
                      <dt class="flex h-7 items-center text-ink-3">Parent</dt>
                      <dd>
                        <button type="button" class={`${PICKER} font-mono text-xs text-ink-2`} onClick={() => open(parent())}>
                          #{parent()}
                        </button>
                      </dd>
                    </>
                  )}
                </Show>
              </dl>

              <span class={LABEL}>Description</span>
              <DescriptionField
                value={issue().description}
                busy={action.busy() === "description"}
                onSave={(draft) => edit("description", descriptionEdit(issue().description, draft))}
              />
              <span class="px-1">
                <FieldError message={action.error("description")} />
              </span>

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

              <span class={LABEL}>Links</span>
              <Links
                groups={[
                  ["blocks", detail().links.blocks],
                  ["blocked_by", detail().links.blockedBy],
                  ["related", detail().links.related],
                ]}
                busy={action.busy() === "links"}
                stateOf={stateOf}
                onOpen={open}
                onRemove={(kind, other) => void link(kind, other, false)}
              />
              <AddLink
                project={issueScope(props.project, props.captain)}
                detail={detail()}
                busy={action.busy() === "links"}
                error={action.error("links")}
                onLink={(kind, other) => link(kind, other, true)}
              />
              <span class="px-1">
                <FieldError message={action.error("links")} />
              </span>

              <Show when={issue().threads.length > 0}>
                <span class={LABEL}>
                  Threads <span class="font-mono text-2xs text-icon">{issue().threads.length}</span>
                </span>
                <For each={issue().threads}>
                  {(thread, index) => {
                    const place = () => threadPlace(thread, threadHome(props.project), homeProjects().map(threadHome))
                    const owner = (): JSX.Element => (
                      <Show when={index() === 0}>
                        <span class="shrink-0 text-xs text-ink-3">Owner</span>
                      </Show>
                    )
                    return (
                      <Show
                        when={place().kind !== "unknown"}
                        fallback={
                          <div class="flex items-start gap-2.5 px-2 py-1.5" title="This thread isn’t in your home, so it can’t open here">
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-sm text-ink-3">Thread {thread}</span>
                              <span class="block truncate text-xs text-icon">Not in your home</span>
                            </span>
                            {owner()}
                          </div>
                        }
                      >
                        <button type="button" class={PANE_ROW} onClick={() => openLinkedThread(thread, place(), props.onOpenThread)}>
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm text-ink">{placeTitle(place(), thread)}</span>
                            <Show when={placeProject(place())}>
                              {(slug) => <span class="block truncate text-xs text-ink-3">In {slug()}</span>}
                            </Show>
                          </span>
                          {owner()}
                        </button>
                      </Show>
                    )
                  }}
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
              <Show when={pages()?.cursor != null}>
                <button
                  type="button"
                  class="link mx-2 mb-1 self-start text-xs text-ink-3"
                  disabled={action.busy() === "older"}
                  onClick={loadOlder}
                >
                  {action.busy() === "older" ? "Loading older activity" : "Load older activity"}
                </button>
              </Show>
              <span class="px-1">
                <FieldError message={action.error("older")} />
              </span>
              <Timeline events={pages()?.events ?? detail().timeline} names={names()} stateName={stateName} />
              <CommentBox id={props.id} />
            </div>
          )
        }}
      </Show>
    </Loading>
  )
}

function threadHome(project: ProjectSummary): ThreadHome {
  const spaces = project.spaces.flatMap((space) => Object.values(space.threads).flat())
  return { id: project.id, slug: project.slug, threads: [...projectThreads(project), ...spaces] }
}

function placeTitle(place: ThreadPlace, thread: number): string {
  return place.kind === "unknown" ? `Thread ${thread}` : place.title
}

function placeProject(place: ThreadPlace): string | undefined {
  return place.kind === "elsewhere" ? place.slug : undefined
}

/** A thread in this pane opens as its tab here; one from another project opens under that project's own address. */
function openLinkedThread(thread: number, place: ThreadPlace, openHere: (id: number) => void): void {
  switch (place.kind) {
    case "here":
      openHere(thread)
      return
    case "elsewhere":
      openThreadTab(place.projectId, thread)
      navigate(`/p/${place.slug}/t/${thread}`)
      return
    case "unknown":
      return
    default: {
      const _exhaustive: never = place
      return _exhaustive
    }
  }
}

/** Everyone the owner can assign: themself, this pane's threads, every Captain, and each project's own coordinator. */
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
  groups: readonly (readonly [LinkKind, readonly LinkedIssue[]])[]
  busy: boolean
  stateOf: (id: string) => IssueState | undefined
  onOpen: (id: number) => void
  onRemove: (kind: LinkKind, other: number) => void
}): JSX.Element {
  return (
    <For
      each={props.groups.filter(([, issues]) => issues.length > 0)}
      fallback={<span class="px-2 text-sm text-ink-3">No links</span>}
    >
      {([kind, issues]) => (
        <>
          <span class="px-2 pb-0.5 pt-1 text-2xs text-icon">{LINK_LABEL[kind]}</span>
          <For each={issues}>
            {(linked) => (
              <div class="group flex items-center">
                <button type="button" class={`${PANE_ROW} min-w-0 flex-1`} onClick={() => props.onOpen(linked.id)}>
                  <StateMark tone={stateTone(props.stateOf(linked.state))} class="mt-0.5" />
                  <span class="mt-px shrink-0 font-mono text-2xs text-ink-3">#{linked.id}</span>
                  <span class="min-w-0 flex-1 truncate text-sm text-ink">{linked.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove the link to #${linked.id}`}
                  disabled={props.busy}
                  class={`${ICON_BUTTON} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                  onClick={() => props.onRemove(kind, linked.id)}
                >
                  <X size={14} stroke-width={1.5} />
                </button>
              </div>
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
  const ids = createCommandIds(mintCommandId)
  const submit = (): void => {
    const text = body().trim()
    if (text === "" || action.busy() !== undefined) return
    void action.run("comment", async () => {
      try {
        await commentOnIssue(props.id, text, ids.idFor(text))
      } catch (problem) {
        ids.settle(problem)
        throw problem
      }
      ids.settle(undefined)
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
