import { isRecord, listOf, numOf, recordOf, strOf, stringsOf } from "./parse.ts"

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const
export type Priority = (typeof PRIORITIES)[number]

export const PRIORITY_LABEL: Readonly<Record<Priority, string>> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
}

export type Assignee = { readonly kind: "person"; readonly id: string } | { readonly kind: "thread" | "captain"; readonly id: number }

export type IssueState = {
  readonly id: string
  readonly name: string
  readonly closed: boolean
  readonly position: number
  readonly isDefault: boolean
}

export type IssueSummary = {
  readonly id: number
  readonly title: string
  readonly state: string
  readonly priority: Priority
  readonly due: string | null
  readonly parent: number | null
  readonly assignees: readonly Assignee[]
  readonly threads: readonly number[]
  readonly prs: readonly string[]
  readonly updatedAt: number
}

export type Issue = IssueSummary & { readonly description: string }

export type LinkedIssue = { readonly id: number; readonly title: string; readonly state: string }

export type IssueEvent = {
  readonly id: number
  readonly at: number
  readonly actor: string
  readonly kind: "created" | "changed" | "comment" | "linked" | "unlinked"
  readonly data: Readonly<Record<string, unknown>>
  readonly replyTo: number | null
}

export type IssueDetail = {
  readonly issue: Issue
  readonly children: readonly IssueSummary[]
  readonly links: {
    readonly blocks: readonly LinkedIssue[]
    readonly blockedBy: readonly LinkedIssue[]
    readonly related: readonly LinkedIssue[]
  }
  readonly timeline: readonly IssueEvent[]
  /** The `before` cursor for the next older timeline page, or null when this page reaches the first event. */
  readonly earlier: number | null
}

/** The state the contract seeds first; the Overview always lists it on top, wherever the owner moved it. */
export const NEEDS_YOU = "needs-you"

const EVENT_KINDS = ["created", "changed", "comment", "linked", "unlinked"] as const

const isPriority = (value: unknown): value is Priority => PRIORITIES.some((priority) => priority === value)
const isEventKind = (value: unknown): value is IssueEvent["kind"] => EVENT_KINDS.some((kind) => kind === value)

function idsOf(value: unknown): readonly number[] {
  return listOf(value).flatMap((entry) => {
    const id = numOf(entry)
    return id === undefined ? [] : [id]
  })
}

function assigneeOf(value: unknown): Assignee | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  if (record.kind === "person") {
    const id = strOf(record.id)
    return id === undefined ? undefined : { kind: "person", id }
  }
  const id = numOf(record.id)
  if (id === undefined) return undefined
  if (record.kind === "thread" || record.kind === "captain") return { kind: record.kind, id }
  return undefined
}

function stateOf(value: unknown): IssueState | undefined {
  const record = recordOf(value)
  const id = strOf(record?.id)
  const name = strOf(record?.name)
  if (record === undefined || id === undefined || name === undefined) return undefined
  return {
    id,
    name,
    closed: record.closed === true,
    position: numOf(record.position) ?? 0,
    isDefault: record.isDefault === true,
  }
}

export function parseStates(value: unknown): readonly IssueState[] {
  return listOf(recordOf(value)?.states)
    .flatMap((entry) => {
      const state = stateOf(entry)
      return state === undefined ? [] : [state]
    })
    .toSorted((left, right) => left.position - right.position)
}

function summaryOf(value: unknown): IssueSummary | undefined {
  const record = recordOf(value)
  const id = numOf(record?.id)
  const title = strOf(record?.title)
  const state = strOf(record?.state)
  if (record === undefined || id === undefined || title === undefined || state === undefined) return undefined
  return {
    id,
    title,
    state,
    priority: isPriority(record.priority) ? record.priority : "normal",
    due: strOf(record.due) ?? null,
    parent: numOf(record.parent) ?? null,
    assignees: listOf(record.assignees).flatMap((entry) => {
      const assignee = assigneeOf(entry)
      return assignee === undefined ? [] : [assignee]
    }),
    threads: idsOf(record.threads),
    prs: stringsOf(record.prs),
    updatedAt: numOf(record.updatedAt) ?? 0,
  }
}

function summariesOf(value: unknown): readonly IssueSummary[] {
  return listOf(value).flatMap((entry) => {
    const issue = summaryOf(entry)
    return issue === undefined ? [] : [issue]
  })
}

export function parseIssuePage(value: unknown): readonly IssueSummary[] {
  return summariesOf(recordOf(value)?.issues)
}

export function parseIssue(value: unknown): Issue | undefined {
  const summary = summaryOf(value)
  if (summary === undefined) return undefined
  return { ...summary, description: strOf(recordOf(value)?.description) ?? "" }
}

function linkedOf(value: unknown): readonly LinkedIssue[] {
  return listOf(value).flatMap((entry) => {
    const record = recordOf(entry)
    const id = numOf(record?.id)
    const title = strOf(record?.title)
    const state = strOf(record?.state)
    return id === undefined || title === undefined || state === undefined ? [] : [{ id, title, state }]
  })
}

function eventOf(value: unknown): IssueEvent | undefined {
  const record = recordOf(value)
  const id = numOf(record?.id)
  const at = numOf(record?.at)
  const actor = strOf(record?.actor)
  if (record === undefined || id === undefined || at === undefined || actor === undefined || !isEventKind(record.kind))
    return undefined
  return { id, at, actor, kind: record.kind, data: recordOf(record.data) ?? {}, replyTo: numOf(record.replyTo) ?? null }
}

export function parseIssueDetail(value: unknown): IssueDetail | undefined {
  const record = recordOf(value)
  const issue = parseIssue(record?.issue)
  if (record === undefined || issue === undefined) return undefined
  const links = recordOf(record.links) ?? {}
  return {
    issue,
    children: summariesOf(record.children),
    links: { blocks: linkedOf(links.blocks), blockedBy: linkedOf(links.blockedBy), related: linkedOf(links.related) },
    timeline: listOf(record.timeline).flatMap((entry) => {
      const event = eventOf(entry)
      return event === undefined ? [] : [event]
    }),
    earlier: numOf(record.earlier) ?? null,
  }
}

/** The `rev` the home snapshot carries for issues: it moves on every issue change. */
export function parseIssuesRev(home: unknown): number {
  return numOf(isRecord(home) ? recordOf(home.issues)?.rev : undefined) ?? 0
}

export type IssueGroup = { readonly state: IssueState; readonly issues: readonly IssueSummary[] }

/** Closed issues under their closed state in the owner's order, for the Overview's closed toggle. */
export function closedGroups(states: readonly IssueState[], issues: readonly IssueSummary[]): readonly IssueGroup[] {
  return states
    .filter((state) => state.closed)
    .flatMap((state) => {
      const members = issues.filter((issue) => issue.state === state.id)
      return members.length === 0 ? [] : [{ state, issues: members }]
    })
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { urgent: 0, high: 1, normal: 2, low: 3 }

/** Open issues under their open state, Needs you first and then the owner's state order; inside a state, by priority, keeping the list's newest-first order. */
export function openGroups(states: readonly IssueState[], issues: readonly IssueSummary[]): readonly IssueGroup[] {
  const order = states
    .filter((state) => !state.closed)
    .toSorted((left, right) => Number(right.id === NEEDS_YOU) - Number(left.id === NEEDS_YOU) || left.position - right.position)
  return order.flatMap((state) => {
    const members = issues
      .filter((issue) => issue.state === state.id)
      .toSorted((left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority])
    return members.length === 0 ? [] : [{ state, issues: members }]
  })
}

export type StateTone = "needs" | "review" | "progress" | "waiting" | "todo" | "backlog" | "done" | "canceled"

const SEEDED_TONES: Readonly<Record<string, StateTone>> = {
  "needs-you": "needs",
  "in-review": "review",
  "in-progress": "progress",
  waiting: "waiting",
  todo: "todo",
  backlog: "backlog",
  done: "done",
  canceled: "canceled",
}

/** How a state's mark looks: the seeded states keep their own, and a state the owner made reads as open or done. */
export function stateTone(state: IssueState | undefined): StateTone {
  if (state === undefined) return "todo"
  return SEEDED_TONES[state.id] ?? (state.closed ? "done" : "todo")
}

/** Today as the contract writes dates, in the viewer's own calendar. */
export function localDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

export type DueLabel = { readonly text: string; readonly overdue: boolean }

export function dueLabel(due: string | null, today: string): DueLabel | undefined {
  const match = due === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/u.exec(due)
  if (due === null || match === null) return undefined
  const month = MONTHS[Number(match[2]) - 1]
  if (month === undefined) return undefined
  const overdue = due < today
  if (due === today) return { text: "Today", overdue: false }
  const year = match[1] === today.slice(0, 4) ? "" : ` ${match[1]}`
  return { text: `${month} ${Number(match[3])}${year}`, overdue }
}

/** Display names for conversations, from what the home already lists. */
export type Names = {
  readonly thread: (id: number) => string | undefined
  readonly captain: (id: number) => string | undefined
}

export function assigneeName(assignee: Assignee, names: Names): string {
  switch (assignee.kind) {
    case "person":
      return assignee.id === "owner" ? "You" : assignee.id
    case "thread":
      return names.thread(assignee.id) ?? `Thread ${assignee.id}`
    case "captain":
      return names.captain(assignee.id) ?? `Captain ${assignee.id}`
    default: {
      const _exhaustive: never = assignee
      return _exhaustive
    }
  }
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word !== "")
  const letters = `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
  return letters.toUpperCase() || "?"
}

/** "person:owner" | "thread:<conv>" as a name. */
export function actorName(actor: string, names: Names): string {
  const cut = actor.indexOf(":")
  const kind = actor.slice(0, cut)
  const id = actor.slice(cut + 1)
  if (kind === "person") return id === "owner" ? "You" : id
  if (kind === "thread") return names.thread(Number(id)) ?? names.captain(Number(id)) ?? `Thread ${id}`
  return actor
}

const LINK_WORDS: Readonly<Record<string, string>> = {
  blocks: "as blocking",
  blocked_by: "as blocked by",
  related: "as related to",
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  title: "the title",
  description: "the description",
  due: "the due date",
  parent: "the parent",
  labels: "the labels",
  assignees: "the assignees",
  threads: "the linked threads",
  prs: "the pull requests",
}

/** One timeline line for anything but a comment, with the actor already named. */
export function eventLine(event: IssueEvent, who: string, stateName: (id: string) => string): string {
  const data = event.data
  switch (event.kind) {
    case "created":
      return `${who} created this issue`
    case "comment":
      return `${who} commented`
    case "linked":
    case "unlinked": {
      const other = numOf(data.issue)
      const target = other === undefined ? "another issue" : `#${other}`
      return event.kind === "linked"
        ? `${who} marked this ${LINK_WORDS[strOf(data.kind) ?? "related"] ?? "as related to"} ${target}`
        : `${who} removed the link to ${target}`
    }
    case "changed": {
      const field = strOf(data.field) ?? "issue"
      if (field === "state")
        return `${who} moved this from ${stateName(strOf(data.from) ?? "")} to ${stateName(strOf(data.to) ?? "")}`
      if (field === "priority") {
        const to = data.to
        return `${who} set the priority to ${isPriority(to) ? PRIORITY_LABEL[to] : "Normal"}`
      }
      if (field === "title") return `${who} renamed this to “${strOf(data.to) ?? ""}”`
      if (field === "due") {
        const to = strOf(data.to)
        return to === undefined ? `${who} cleared the due date` : `${who} set the due date to ${to}`
      }
      return `${who} changed ${FIELD_WORDS[field] ?? field}`
    }
    default: {
      const _exhaustive: never = event.kind
      return _exhaustive
    }
  }
}

export type TimelineItem =
  | { readonly kind: "event"; readonly event: IssueEvent }
  | { readonly kind: "comment"; readonly event: IssueEvent; readonly replies: readonly IssueEvent[] }

/** Comments carry their one level of replies; a reply whose parent fell outside the page stands alone. */
export function timelineItems(events: readonly IssueEvent[]): readonly TimelineItem[] {
  const tops = new Set(events.filter((event) => event.kind === "comment" && event.replyTo === null).map((event) => event.id))
  return events.flatMap((event): TimelineItem[] => {
    if (event.kind !== "comment") return [{ kind: "event", event }]
    if (event.replyTo !== null && tops.has(event.replyTo)) return []
    return [{ kind: "comment", event, replies: events.filter((reply) => reply.kind === "comment" && reply.replyTo === event.id) }]
  })
}

export function commentBody(event: IssueEvent): string {
  return strOf(event.data.body) ?? ""
}

export type NewIssue = {
  readonly title: string
  readonly priority?: Priority | undefined
  readonly state?: string | undefined
  readonly project: string
}

/** `issue.create` args from the New issue form, or nothing while the title is blank. */
export function newIssueArgs(input: NewIssue): Record<string, unknown> | undefined {
  const title = input.title.trim()
  if (title === "") return undefined
  return {
    title,
    project: input.project,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.state === undefined ? {} : { state: input.state }),
  }
}

export const LIST_MAX = 20

/** One issue.update payload, or the reason the edit cannot be sent, or nothing when it changes nothing. */
export type Edit = { readonly kind: "send"; readonly fields: Record<string, unknown> } | { readonly kind: "invalid"; readonly message: string } | { readonly kind: "same" }

const SAME: Edit = { kind: "same" }

export function titleEdit(current: string, draft: string): Edit {
  const title = draft.trim()
  if (title === current) return SAME
  if (title === "") return { kind: "invalid", message: "A title cannot be empty" }
  return { kind: "send", fields: { title } }
}

export function descriptionEdit(current: string, draft: string): Edit {
  const description = draft.trimEnd()
  return description === current ? SAME : { kind: "send", fields: { description } }
}

/** A date input's value (YYYY-MM-DD, or empty for Clear) as the `due` field. */
export function dueEdit(current: string | null, value: string): Edit {
  const due = value === "" ? null : value
  if (due === current) return SAME
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(due)) return { kind: "invalid", message: "Pick a date" }
  return { kind: "send", fields: { due } }
}

export function sameAssignee(left: Assignee, right: Assignee): boolean {
  return left.kind === right.kind && left.id === right.id
}

/** The whole assignee list after one add or remove, since issue.update replaces the list. */
export function assigneesEdit(current: readonly Assignee[], change: { readonly add: Assignee } | { readonly remove: Assignee }): Edit {
  if ("remove" in change) {
    const next = current.filter((entry) => !sameAssignee(entry, change.remove))
    return next.length === current.length ? SAME : { kind: "send", fields: { assignees: next } }
  }
  if (current.some((entry) => sameAssignee(entry, change.add))) return SAME
  if (current.length >= LIST_MAX) return { kind: "invalid", message: `At most ${LIST_MAX} assignees` }
  return { kind: "send", fields: { assignees: [...current, change.add] } }
}

export type Candidate = { readonly assignee: Assignee; readonly name: string; readonly detail: string }

/** Who can be assigned: the owner, this project's threads and every Captain, minus who already is, matched on the query. */
export function assigneeCandidates(all: readonly Candidate[], current: readonly Assignee[], query: string): readonly Candidate[] {
  const text = query.trim().toLowerCase()
  return all.filter(
    (candidate) =>
      !current.some((entry) => sameAssignee(entry, candidate.assignee)) &&
      (text === "" || candidate.name.toLowerCase().includes(text) || candidate.detail.toLowerCase().includes(text)),
  )
}

export const LINK_KINDS = ["blocks", "blocked_by", "related"] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const LINK_LABEL: Readonly<Record<LinkKind, string>> = { blocks: "Blocks", blocked_by: "Blocked by", related: "Related" }

/** "12" or "#12" as an issue id, for the link field's direct entry. */
export function issueIdOf(text: string): number | undefined {
  const match = /^#?(\d+)$/u.exec(text.trim())
  if (match === null) return undefined
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export function linkedIds(links: IssueDetail["links"]): ReadonlySet<number> {
  return new Set([...links.blocks, ...links.blockedBy, ...links.related].map((entry) => entry.id))
}

/** issue.link args, or why that link cannot be made from here. */
export function linkArgs(
  id: number,
  kind: LinkKind,
  other: number,
  links: IssueDetail["links"],
): { readonly kind: "send"; readonly args: Record<string, unknown> } | { readonly kind: "invalid"; readonly message: string } {
  if (other === id) return { kind: "invalid", message: "An issue cannot link to itself" }
  const existing = kind === "blocks" ? links.blocks : kind === "blocked_by" ? links.blockedBy : links.related
  if (existing.some((entry) => entry.id === other)) return { kind: "invalid", message: `#${other} is already listed there` }
  return { kind: "send", args: { id, kind, other } }
}

/** Every timeline event the view has read, oldest first, and the cursor for the page before them. */
export type TimelinePages = { readonly events: readonly IssueEvent[]; readonly cursor: number | null; readonly paged: boolean }

function mergeEvents(left: readonly IssueEvent[], right: readonly IssueEvent[]): readonly IssueEvent[] {
  const byId = new Map<number, IssueEvent>()
  for (const event of [...left, ...right]) byId.set(event.id, event)
  return [...byId.values()].toSorted((a, b) => a.id - b.id)
}

/** A re-read of the newest page joins what was read before, so a page loaded earlier never leaves a gap, and keeps the older cursor once paging began. */
export function withHead(pages: TimelinePages | undefined, head: IssueDetail): TimelinePages {
  if (pages === undefined) return { events: head.timeline, cursor: head.earlier, paged: false }
  return { events: mergeEvents(pages.events, head.timeline), cursor: pages.paged ? pages.cursor : head.earlier, paged: pages.paged }
}

export function withOlder(pages: TimelinePages, older: IssueDetail): TimelinePages {
  return { events: mergeEvents(older.timeline, pages.events), cursor: older.earlier, paged: true }
}
