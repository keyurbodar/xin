import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite"
import { OpRejected } from "../../src/kernel/index.ts"

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const
export type Priority = (typeof PRIORITIES)[number]

export const LINK_KINDS = ["blocks", "blocked_by", "related"] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export type Assignee =
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "thread" | "captain"; readonly id: number }

export type IssueActor =
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "thread"; readonly id: number }

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
  readonly project: string | null
  readonly labels: string[]
  readonly assignees: Assignee[]
  readonly threads: number[]
  readonly prs: string[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
}

export type Issue = IssueSummary & { readonly description: string }

export type LinkedIssue = { readonly id: number; readonly title: string; readonly state: string }

export type IssueEvent = {
  readonly id: number
  readonly issue: number
  readonly at: number
  readonly actor: string
  readonly kind: "created" | "changed" | "comment" | "linked" | "unlinked"
  readonly data: { [key: string]: JsonValue }
  readonly replyTo: number | null
}

export type IssueDetail = {
  readonly issue: Issue
  readonly children: IssueSummary[]
  readonly links: {
    readonly blocks: LinkedIssue[]
    readonly blockedBy: LinkedIssue[]
    readonly related: LinkedIssue[]
  }
  readonly timeline: IssueEvent[]
  readonly earlier: number | null
}

export type IssueFields = {
  readonly title?: string
  readonly description?: string
  readonly state?: string
  readonly priority?: Priority
  readonly due?: string | null
  readonly parent?: number | null
  readonly labels?: string[]
  readonly assignees?: Assignee[]
  readonly threads?: number[]
  readonly prs?: string[]
}

export type IssueFilter = {
  readonly q?: string
  readonly assignee?: Assignee
  readonly states?: string[]
  readonly closed?: boolean
  readonly parent?: number | null
  readonly project?: string
  readonly limit?: number
  readonly cursor?: string
}

export type IssuePage = { readonly issues: IssueSummary[]; readonly cursor: string | null }

export type Wake = {
  readonly commandId: string
  readonly issue: number
  readonly target: number
  readonly title: string
  readonly status: string
  readonly text: string
}

export type Change = { readonly issue: Issue; readonly events: IssueEvent[]; readonly wakes: Wake[] }

type Revs = { readonly rev: number; readonly statesRev: number }

type CreateFields = IssueFields & { readonly project?: string }

export interface IssuesService {
  states(): Promise<IssueState[]>
  createState(input: { readonly name: string; readonly closed: boolean }): Promise<IssueState>
  updateState(input: {
    readonly id: string
    readonly name?: string
    readonly position?: number
    readonly isDefault?: true
  }): Promise<IssueState>
  deleteState(
    actor: IssueActor,
    input: { readonly id: string; readonly moveTo: string },
  ): Promise<{ readonly moved: number; readonly wakes: Wake[] }>
  create(actor: IssueActor, fields: CreateFields & { readonly title: string }): Promise<Change>
  /** Refuses, before anything is written, a link from an issue `fields` would create to one it may not link. */
  linkable(actor: IssueActor, fields: CreateFields, other: number): Promise<void>
  get(actor: IssueActor, id: number, before?: number): Promise<IssueDetail | undefined>
  list(actor: IssueActor, filter: IssueFilter): Promise<IssuePage>
  update(actor: IssueActor, id: number, fields: IssueFields): Promise<Change>
  link(actor: IssueActor, id: number, kind: LinkKind, other: number, on: boolean): Promise<Change>
  comment(
    actor: IssueActor,
    id: number,
    input: { readonly body: string; readonly replyTo?: number; readonly mentions?: number[] },
  ): Promise<Change>
  pending(): Promise<Wake[]>
  delivered(commandId: string): Promise<void>
  revs(): Promise<Revs>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    issues: IssuesService
  }
}

export type IssuesPort = {
  readonly db: SqliteDatabase
  conversationExists(id: number): Promise<boolean>
  projectOf(conversation: number): Promise<string | undefined>
  projectId(ref: string): Promise<string | undefined>
  now(): number
}

const LIST_LIMIT = 50
const LIST_MAX = 200
const TIMELINE_PAGE = 100
const AGENT_HOPS = 3
const MANY = 20
const DATE = /^\d{4}-\d{2}-\d{2}$/
const URL_PATTERN = /^https?:\/\/\S+$/
const WAKE_TEXT_MAX = 2000
const LIMITS = { title: 300, description: 20_000, label: 40, pr: 500, person: 120, body: 20_000, q: 200 } as const

type IssueRow = {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly state: string
  readonly priority: string
  readonly due: string | null
  readonly parent: number | null
  readonly project: string | null
  readonly labels: string
  readonly assignees: string
  readonly threads: string
  readonly prs: string
  readonly created_at: number
  readonly updated_at: number
  readonly closed_at: number | null
}

type StateRow = {
  readonly id: string
  readonly name: string
  readonly closed: number
  readonly position: number
  readonly is_default: number
}

type EventRow = {
  readonly id: number
  readonly issue_id: number
  readonly at: number
  readonly actor: string
  readonly kind: IssueEvent["kind"]
  readonly data: string
  readonly reply_to: number | null
}

type WakeRow = {
  readonly command_id: string
  readonly issue_id: number
  readonly target: number
  readonly title: string
  readonly status: string
  readonly text: string
}

type LinkRow = {
  readonly from_id: number
  readonly kind: string
  readonly id: number
  readonly title: string
  readonly state: string
}

type Scope = { readonly project: string } | undefined

const SUMMARY_COLUMNS =
  "id, title, state, priority, due, parent, project, labels, assignees, threads, prs, created_at, updated_at, closed_at"
const EVENT_COLUMNS = "id, issue_id, at, actor, kind, data, reply_to"
const STATE_COLUMNS = "id, name, closed, position, is_default"

const fail = (message: string): never => {
  throw new OpRejected("bad_args", message)
}

export const assigneeToken = (assignee: Assignee | IssueActor): string => `${assignee.kind}:${assignee.id}`

const isPriority = (value: string): value is Priority => PRIORITIES.some((priority) => priority === value)

const strings = (json: string): string[] => {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

const numbers = (json: string): number[] => {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : []
}

function assigneesOf(value: unknown): Assignee[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown): Assignee[] => {
    if (typeof item !== "object" || item === null) return []
    const kind: unknown = Reflect.get(item, "kind")
    const id: unknown = Reflect.get(item, "id")
    if (kind === "person" && typeof id === "string") return [{ kind, id }]
    if ((kind === "thread" || kind === "captain") && typeof id === "number") return [{ kind, id }]
    return []
  })
}

function summaryOf(row: Omit<IssueRow, "description">): IssueSummary {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    priority: isPriority(row.priority) ? row.priority : "normal",
    due: row.due,
    parent: row.parent,
    project: row.project,
    labels: strings(row.labels),
    assignees: assigneesOf(JSON.parse(row.assignees)),
    threads: numbers(row.threads),
    prs: strings(row.prs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

const issueOf = (row: IssueRow): Issue => ({ ...summaryOf(row), description: row.description })

const stateOf = (row: StateRow): IssueState => ({
  id: row.id,
  name: row.name,
  closed: row.closed === 1,
  position: row.position,
  isDefault: row.is_default === 1,
})

function eventOf(row: EventRow): IssueEvent {
  const data: JsonValue = JSON.parse(row.data)
  return {
    id: row.id,
    issue: row.issue_id,
    at: row.at,
    actor: row.actor,
    kind: row.kind,
    data: typeof data === "object" && data !== null && !Array.isArray(data) ? data : {},
    replyTo: row.reply_to,
  }
}

const wakeOf = (row: WakeRow): Wake => ({
  commandId: row.command_id,
  issue: row.issue_id,
  target: row.target,
  title: row.title,
  status: row.status,
  text: row.text,
})

const unique = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const id = key(item)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "state"

const ftsQuery = (q: string): string | undefined => {
  const tokens = q.slice(0, LIMITS.q).match(/[\p{L}\p{N}_]+/gu) ?? []
  if (tokens.length === 0) return undefined
  return tokens.map((token) => (token.length >= 3 ? `"${token}"*` : `"${token}"`)).join(" ")
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const encodeCursor = (issue: IssueSummary): string => `${issue.updatedAt}.${issue.id}`

function decodeOffset(cursor: string): number {
  const match = /^r(\d+)$/.exec(cursor)
  if (match === null) return fail("cursor is not one this search returned")
  return Number(match[1])
}

function decodeCursor(cursor: string): readonly [number, number] {
  const match = /^(\d+)\.(\d+)$/.exec(cursor)
  if (match === null) return fail("cursor is not one this list returned")
  return [Number(match[1]), Number(match[2])]
}

const clip = (text: string): string => (text.length > WAKE_TEXT_MAX ? `${text.slice(0, WAKE_TEXT_MAX)}…` : text)

const within = (text: string, max: number, what: string): void => {
  if (text.length > max) fail(`${what} is longer than ${max} characters`)
}

const stateRows = async (q: SqliteExecutor): Promise<StateRow[]> =>
  q.all<StateRow>(`SELECT ${STATE_COLUMNS} FROM issue_states ORDER BY position, id`)

const stateById = async (q: SqliteExecutor, id: string): Promise<StateRow> =>
  (await q.get<StateRow>(`SELECT ${STATE_COLUMNS} FROM issue_states WHERE id = ?`, id)) ?? fail(`unknown state ${id}`)

const row = async (q: SqliteExecutor, id: number): Promise<IssueRow | undefined> =>
  q.get<IssueRow>(`SELECT ${SUMMARY_COLUMNS}, description FROM issues WHERE id = ?`, id)

const requireRow = async (q: SqliteExecutor, id: number): Promise<IssueRow> =>
  (await row(q, id)) ?? fail(`no issue #${id}`)

const visible = async (q: SqliteExecutor, id: number, scope: Scope): Promise<IssueRow> => {
  const found = await row(q, id)
  if (found === undefined || (scope !== undefined && found.project !== scope.project)) return fail(`no issue #${id}`)
  return found
}

const appendEvent = async (
  q: SqliteExecutor,
  issue: number,
  actor: IssueActor,
  at: number,
  kind: IssueEvent["kind"],
  data: { [key: string]: JsonValue },
  replyTo: number | null = null,
): Promise<IssueEvent> => {
  const inserted = await q.get<EventRow>(
    `INSERT INTO issue_events (issue_id, at, actor, kind, data, reply_to) VALUES (?, ?, ?, ?, ?, ?)
     RETURNING ${EVENT_COLUMNS}`,
    issue,
    at,
    assigneeToken(actor),
    kind,
    JSON.stringify(data),
    replyTo,
  )
  if (inserted === undefined) throw new Error("issue event insert returned nothing")
  return eventOf(inserted)
}

const touch = async (q: SqliteExecutor, id: number, at: number): Promise<Issue> => {
  await q.run("UPDATE issues SET updated_at = ? WHERE id = ?", at, id)
  return issueOf(await requireRow(q, id))
}

const syncAssignees = async (q: SqliteExecutor, id: number, before: Assignee[], after: Assignee[]): Promise<void> => {
  const old = new Set(before.map(assigneeToken))
  const next = new Set(after.map(assigneeToken))
  for (const token of old)
    if (!next.has(token)) await q.run("DELETE FROM issue_assignees WHERE assignee = ? AND issue_id = ?", token, id)
  for (const token of next)
    if (!old.has(token)) await q.run("INSERT INTO issue_assignees (assignee, issue_id) VALUES (?, ?)", token, id)
}

const bumpStates = async (q: SqliteExecutor): Promise<void> => {
  await q.run(
    "INSERT INTO issue_meta (key, value) VALUES ('states_rev', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1",
  )
}

const stateName = async (q: SqliteExecutor, id: JsonValue | undefined): Promise<string> =>
  typeof id === "string"
    ? ((await q.get<{ name: string }>("SELECT name FROM issue_states WHERE id = ?", id))?.name ?? id)
    : "none"

function changeState(before: Issue, to: StateRow, sets: string[], params: SqliteValue[], at: number): void {
  sets.push("state = ?")
  params.push(to.id)
  if (to.closed === 1 && before.closedAt === null) {
    sets.push("closed_at = ?")
    params.push(at)
  } else if (to.closed === 0 && before.closedAt !== null) sets.push("closed_at = NULL")
}

/**
 * Plans the wakes a change causes and stores them in the outbox inside the same transaction as the change. Each
 * agent change that wakes someone is one hop; past `AGENT_HOPS` hops since a person last acted, agent changes wake
 * nobody until a person acts again.
 */
async function queueWakes(q: SqliteExecutor, issue: Issue, events: IssueEvent[], actor: IssueActor): Promise<Wake[]> {
  const self = actor.kind === "thread" ? actor.id : undefined
  const owner = issue.threads[0]
  const planned = new Map<number, { commandId: string; lines: string[] }>()
  const add = (target: number | undefined, event: IssueEvent, text: string): void => {
    if (target === undefined || target === self) return
    const found = planned.get(target)
    if (found === undefined) planned.set(target, { commandId: `issue:${event.id}:${target}`, lines: [text] })
    else found.lines.push(text)
  }
  const newlyAssigned = (event: IssueEvent, before: Assignee[]): void => {
    const had = new Set(before.map(assigneeToken))
    for (const assignee of issue.assignees)
      if (assignee.kind !== "person" && !had.has(assigneeToken(assignee)))
        add(assignee.id, event, `${event.actor} assigned you.`)
  }
  for (const event of events) {
    if (event.kind === "created") newlyAssigned(event, [])
    if (event.kind === "comment") {
      const body = typeof event.data["body"] === "string" ? event.data["body"] : ""
      add(owner, event, `${event.actor} commented${event.replyTo === null ? "" : " in a reply"}: ${body}`)
      const mentioned = Array.isArray(event.data["mentions"]) ? event.data["mentions"] : []
      for (const target of mentioned)
        if (typeof target === "number") add(target, event, `${event.actor} mentioned you: ${body}`)
    }
    if (event.kind === "changed" && event.data["field"] === "state")
      add(
        owner,
        event,
        `${event.actor} moved it from ${await stateName(q, event.data["from"])} to ${await stateName(q, event.data["to"])}.`,
      )
    if (event.kind === "changed" && event.data["field"] === "assignees") {
      const names = issue.assignees.map(assigneeToken)
      add(owner, event, `${event.actor} set the assignees to ${names.length === 0 ? "nobody" : names.join(", ")}.`)
      newlyAssigned(event, assigneesOf(event.data["from"]))
    }
  }
  const hops =
    (await q.get<{ agent_hops: number }>("SELECT agent_hops FROM issues WHERE id = ?", issue.id))?.agent_hops ?? 0
  if (actor.kind === "person") {
    if (hops !== 0) await q.run("UPDATE issues SET agent_hops = 0 WHERE id = ?", issue.id)
  } else if (planned.size > 0) {
    if (hops >= AGENT_HOPS) return []
    await q.run("UPDATE issues SET agent_hops = ? WHERE id = ?", hops + 1, issue.id)
  }
  const wakes: Wake[] = []
  for (const [target, plan] of planned) {
    const wake: Wake = {
      commandId: plan.commandId,
      issue: issue.id,
      target,
      title: `#${issue.id} ${issue.title}`,
      status: issue.state,
      text: `${clip(plan.lines.join("\n"))}\nOpen issue #${issue.id} for the full record.`,
    }
    await q.run(
      `INSERT INTO issue_wakes (command_id, issue_id, target, title, status, text) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      wake.commandId,
      wake.issue,
      wake.target,
      wake.title,
      wake.status,
      wake.text,
    )
    wakes.push(wake)
  }
  return wakes
}

const apart = (left: string | null, right: string | null): boolean => left !== null && right !== null && left !== right

const normalize = async (
  q: SqliteExecutor,
  fields: IssueFields,
  self: number | undefined,
  project: string | null,
  scope: Scope,
) => {
  const title = fields.title?.trim()
  if (title !== undefined && title.length === 0) fail("a title cannot be empty")
  if (title !== undefined) within(title, LIMITS.title, "a title")
  if (fields.description !== undefined) within(fields.description, LIMITS.description, "a description")
  if (fields.due !== undefined && fields.due !== null && !DATE.test(fields.due)) fail("due must be YYYY-MM-DD")
  if (fields.state !== undefined) await stateById(q, fields.state)
  const labels =
    fields.labels === undefined
      ? undefined
      : unique(
          fields.labels.map((label) => label.trim()),
          String,
        )
  if (labels?.some((label) => label.length === 0)) fail("a label cannot be empty")
  for (const label of labels ?? []) within(label, LIMITS.label, "a label")
  const assignees = fields.assignees === undefined ? undefined : unique(fields.assignees, assigneeToken)
  for (const assignee of assignees ?? [])
    if (assignee.kind === "person") within(assignee.id, LIMITS.person, "a person id")
  const threads = fields.threads === undefined ? undefined : unique(fields.threads, String)
  const prs = fields.prs === undefined ? undefined : unique(fields.prs, String)
  if (prs?.some((url) => !URL_PATTERN.test(url) || url.length > LIMITS.pr))
    fail(`a pull request link must be an http(s) URL of at most ${LIMITS.pr} characters`)
  for (const list of [labels, assignees, threads, prs])
    if (list !== undefined && list.length > MANY) fail(`at most ${MANY} entries per list`)
  if (fields.parent !== undefined && fields.parent !== null) {
    if (fields.parent === self) fail("an issue cannot be its own parent")
    const parent = await visible(q, fields.parent, scope)
    if (apart(project, parent.project)) fail(`#${parent.id} is in another project`)
    if (parent.parent !== null) fail(`#${parent.id} is already a sub-issue; sub-issues go one level deep`)
    if (self !== undefined && (await q.get<{ id: number }>("SELECT id FROM issues WHERE parent = ? LIMIT 1", self)))
      fail(`#${self} has sub-issues, so it cannot become one`)
  }
  return {
    ...fields,
    ...(title === undefined ? {} : { title }),
    ...(labels === undefined ? {} : { labels }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(threads === undefined ? {} : { threads }),
    ...(prs === undefined ? {} : { prs }),
  }
}

/**
 * Once per Home: rewrites issues that stored a project slug (before create resolved it) to that project's id, one indexed
 * UPDATE per slug, then marks it done in issue_meta. The UPDATEs are idempotent, so a crash before the mark reruns them.
 */
export async function adoptProjectIds(
  db: SqliteDatabase,
  projects: () => Promise<Iterable<readonly [id: string, slug: string]>>,
): Promise<void> {
  if (await db.get("SELECT value FROM issue_meta WHERE key = 'project_ids'")) return
  for (const [id, slug] of await projects())
    if (slug !== id) await db.run("UPDATE issues SET project = ? WHERE project = ?", id, slug)
  await db.run("INSERT INTO issue_meta (key, value) VALUES ('project_ids', 1) ON CONFLICT (key) DO NOTHING")
}

export function createIssues(port: IssuesPort): IssuesService {
  const { db } = port
  let revs: Revs | undefined

  const write = async <T>(work: (tx: SqliteExecutor) => Promise<T>): Promise<T> => {
    try {
      return await db.transaction(work)
    } finally {
      revs = undefined
    }
  }

  const scopeOf = async (actor: IssueActor): Promise<Scope> => {
    if (actor.kind === "person") return undefined
    const project = await port.projectOf(actor.id)
    return project === undefined ? undefined : { project }
  }

  /** Refuses a conversation in another project: any other project for an agent, a different one for the owner. */
  const conversations = async (ids: readonly number[], what: string, project: string | null, scope: Scope) => {
    for (const id of ids) {
      if (!(await port.conversationExists(id))) fail(`${what} ${id} is not a conversation`)
      const theirs = (await port.projectOf(id)) ?? null
      const outside =
        scope === undefined ? theirs !== null && project !== null && theirs !== project : theirs !== project
      if (outside) fail(`${what} ${id} is outside this project`)
    }
  }

  const checkConversations = async (fields: IssueFields, project: string | null, scope: Scope): Promise<void> => {
    if (fields.assignees !== undefined)
      await conversations(
        fields.assignees.flatMap((assignee) => (assignee.kind === "person" ? [] : [assignee.id])),
        "assignee",
        project,
        scope,
      )
    if (fields.threads !== undefined) await conversations(fields.threads, "thread", project, scope)
  }

  /** The project an issue created from `input` lands in. */
  const landing = async (input: CreateFields, scope: Scope): Promise<string | null> => {
    const owner = input.threads?.[0]
    if (scope !== undefined) return scope.project
    if (input.project !== undefined) return (await port.projectId(input.project)) ?? fail(`no project ${input.project}`)
    return (owner === undefined ? undefined : await port.projectOf(owner)) ?? null
  }

  const projectOfIssue = async (id: number): Promise<string | null> => (await row(db, id))?.project ?? null

  const linked = async (id: number): Promise<IssueDetail["links"]> => {
    const rows = await db.all<LinkRow>(
      `SELECT l.from_id, l.kind, i.id, i.title, i.state FROM issue_links l
       JOIN issues i ON i.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
       WHERE l.from_id = ? OR l.to_id = ? ORDER BY i.id`,
      id,
      id,
      id,
    )
    const view = (link: LinkRow): LinkedIssue => ({ id: link.id, title: link.title, state: link.state })
    return {
      blocks: rows.filter((link) => link.kind === "blocks" && link.from_id === id).map(view),
      blockedBy: rows.filter((link) => link.kind === "blocks" && link.from_id !== id).map(view),
      related: rows.filter((link) => link.kind === "related").map(view),
    }
  }

  return {
    states: async () => (await stateRows(db)).map(stateOf),

    createState: async (input) => {
      const name = input.name.trim()
      if (name.length === 0) fail("a state needs a name")
      return write(async (tx) => {
        const rows = await stateRows(tx)
        const base = slugOf(name)
        let id = base
        for (let n = 2; rows.some((state) => state.id === id); n += 1) id = `${base}-${n}`
        const position = rows.reduce((max, state) => Math.max(max, state.position), -1) + 1
        await tx.run(
          "INSERT INTO issue_states (id, name, closed, position, is_default) VALUES (?, ?, ?, ?, 0)",
          id,
          name,
          input.closed ? 1 : 0,
          position,
        )
        await bumpStates(tx)
        return stateOf(await stateById(tx, id))
      })
    },

    updateState: async (input) => {
      const name = input.name?.trim()
      if (name !== undefined && name.length === 0) fail("a state needs a name")
      return write(async (tx) => {
        const state = await stateById(tx, input.id)
        let changed = 0
        if (name !== undefined)
          changed += await tx.runCounted(
            "UPDATE issue_states SET name = ? WHERE id = ? AND name != ?",
            name,
            state.id,
            name,
          )
        if (input.position !== undefined) {
          const order = (await stateRows(tx)).filter((other) => other.id !== state.id).map((other) => other.id)
          order.splice(Math.max(0, Math.min(input.position, order.length)), 0, state.id)
          for (const [position, id] of order.entries())
            changed += await tx.runCounted(
              "UPDATE issue_states SET position = ? WHERE id = ? AND position != ?",
              position,
              id,
              position,
            )
        }
        if (input.isDefault === true && state.is_default === 0)
          changed += await tx.runCounted(
            "UPDATE issue_states SET is_default = (id = ?) WHERE closed = ?",
            state.id,
            state.closed,
          )
        if (changed > 0) await bumpStates(tx)
        return stateOf(await stateById(tx, state.id))
      })
    },

    deleteState: async (actor, input) => {
      const at = port.now()
      return write(async (tx) => {
        const state = await stateById(tx, input.id)
        if (state.is_default === 1) fail(`${state.name} is a default state; make another state the default first`)
        if (input.moveTo === state.id) fail("move its issues to a different state")
        const target = await stateById(tx, input.moveTo)
        const moved = await tx.all<IssueRow>(
          `SELECT ${SUMMARY_COLUMNS}, description FROM issues WHERE state = ?`,
          state.id,
        )
        const wakes: Wake[] = []
        for (const found of moved) {
          const before = issueOf(found)
          const sets: string[] = []
          const params: SqliteValue[] = []
          changeState(before, target, sets, params, at)
          await tx.run(`UPDATE issues SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, at, before.id)
          const event = await appendEvent(tx, before.id, actor, at, "changed", {
            field: "state",
            from: state.id,
            to: target.id,
          })
          wakes.push(...(await queueWakes(tx, issueOf(await requireRow(tx, before.id)), [event], actor)))
        }
        await tx.run("DELETE FROM issue_states WHERE id = ?", state.id)
        await bumpStates(tx)
        return { moved: moved.length, wakes }
      })
    },

    linkable: async (actor, input, other) => {
      const scope = await scopeOf(actor)
      const target = await visible(db, other, scope)
      if (apart(await landing(input, scope), target.project)) fail(`#${other} is in another project`)
    },

    create: async (actor, input) => {
      const scope = await scopeOf(actor)
      const project = await landing(input, scope)
      await checkConversations(input, project, scope)
      const at = port.now()
      return write(async (tx) => {
        const fields = await normalize(tx, input, undefined, project, scope)
        const state =
          fields.state === undefined
            ? ((await tx.get<StateRow>(
                `SELECT ${STATE_COLUMNS} FROM issue_states WHERE is_default = 1 AND closed = 0`,
              )) ?? fail("no default state is set"))
            : await stateById(tx, fields.state)
        const created = await tx.get<{ id: number }>(
          `INSERT INTO issues (title, description, state, priority, due, parent, project, labels, assignees, threads, prs, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          fields.title ?? "",
          fields.description ?? "",
          state.id,
          fields.priority ?? "normal",
          fields.due ?? null,
          fields.parent ?? null,
          project,
          JSON.stringify(fields.labels ?? []),
          JSON.stringify(fields.assignees ?? []),
          JSON.stringify(fields.threads ?? []),
          JSON.stringify(fields.prs ?? []),
          at,
          at,
          state.closed === 1 ? at : null,
        )
        if (created === undefined) throw new Error("issue insert returned nothing")
        await syncAssignees(tx, created.id, [], fields.assignees ?? [])
        const event = await appendEvent(tx, created.id, actor, at, "created", {})
        const issue = issueOf(await requireRow(tx, created.id))
        return { issue, events: [event], wakes: await queueWakes(tx, issue, [event], actor) }
      })
    },

    get: async (actor, id, before) => {
      const scope = await scopeOf(actor)
      const found = await row(db, id)
      if (found === undefined || (scope !== undefined && found.project !== scope.project)) return undefined
      const [children, links, events] = await Promise.all([
        db.all<IssueRow>(`SELECT ${SUMMARY_COLUMNS} FROM issues WHERE parent = ? ORDER BY id`, id),
        linked(id),
        db.all<EventRow>(
          `SELECT ${EVENT_COLUMNS} FROM issue_events WHERE issue_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          id,
          before ?? Number.MAX_SAFE_INTEGER,
          TIMELINE_PAGE + 1,
        ),
      ])
      const page = events.slice(0, TIMELINE_PAGE).toReversed().map(eventOf)
      return {
        issue: issueOf(found),
        children: children.map(summaryOf),
        links,
        timeline: page,
        earlier: events.length > TIMELINE_PAGE ? (page[0]?.id ?? null) : null,
      }
    },

    list: async (actor, filter) => {
      const scope = await scopeOf(actor)
      const project =
        scope?.project ??
        (filter.project === undefined
          ? undefined
          : ((await port.projectId(filter.project)) ?? fail(`no project ${filter.project}`)))
      const filters: string[] = []
      const params: SqliteValue[] = []
      if (filter.assignee !== undefined) {
        filters.push("id IN (SELECT issue_id FROM issue_assignees WHERE assignee = ?)")
        params.push(assigneeToken(filter.assignee))
      }
      if (filter.states !== undefined && filter.states.length > 0) {
        filters.push(`state IN (${filter.states.map(() => "?").join(", ")})`)
        params.push(...filter.states)
      }
      if (filter.closed !== undefined) filters.push(filter.closed ? "closed_at IS NOT NULL" : "closed_at IS NULL")
      if (filter.parent === null) filters.push("parent IS NULL")
      else if (filter.parent !== undefined) {
        filters.push("parent = ?")
        params.push(filter.parent)
      }
      const limit = Math.max(1, Math.min(filter.limit ?? LIST_LIMIT, LIST_MAX))
      if (project !== undefined) {
        filters.push("project = ?")
        params.push(project)
      }
      const match = filter.q === undefined ? undefined : ftsQuery(filter.q)
      if (match !== undefined) {
        const offset = filter.cursor === undefined ? 0 : decodeOffset(filter.cursor)
        const joined = filters.length > 0
        const rows = await db.all<IssueRow>(
          `SELECT ${SUMMARY_COLUMNS} FROM (
             SELECT issues_fts.rowid AS hit, rank AS score FROM issues_fts
             ${joined ? "JOIN issues ON issues.id = issues_fts.rowid" : ""}
             WHERE issues_fts MATCH ? ${joined ? `AND ${filters.join(" AND ")}` : ""}
             ORDER BY rank LIMIT ? OFFSET ?
           ) JOIN issues ON id = hit ORDER BY score, id`,
          match,
          ...params,
          limit + 1,
          offset,
        )
        return {
          issues: rows.slice(0, limit).map(summaryOf),
          cursor: rows.length > limit ? `r${offset + limit}` : null,
        }
      }
      if (filter.cursor !== undefined) {
        const [updatedAt, id] = decodeCursor(filter.cursor)
        filters.push("(updated_at < ? OR (updated_at = ? AND id < ?))")
        params.push(updatedAt, updatedAt, id)
      }
      const rows = await db.all<IssueRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM issues ${filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ...params,
        limit + 1,
      )
      const issues = rows.slice(0, limit).map(summaryOf)
      const last = issues.at(-1)
      return { issues, cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null }
    },

    update: async (actor, id, input) => {
      const scope = await scopeOf(actor)
      const project = await projectOfIssue(id)
      await checkConversations(input, project, scope)
      const at = port.now()
      return write(async (tx) => {
        const before = issueOf(await visible(tx, id, scope))
        const fields = await normalize(tx, input, id, before.project, scope)
        const events: IssueEvent[] = []
        const sets: string[] = []
        const params: SqliteValue[] = []
        const change = async (
          field: string,
          column: string,
          value: SqliteValue,
          data: { [key: string]: JsonValue },
        ) => {
          sets.push(`${column} = ?`)
          params.push(value)
          events.push(await appendEvent(tx, id, actor, at, "changed", { field, ...data }))
        }
        if (fields.title !== undefined && fields.title !== before.title)
          await change("title", "title", fields.title, { from: before.title, to: fields.title })
        if (fields.description !== undefined && fields.description !== before.description)
          await change("description", "description", fields.description, {})
        if (fields.state !== undefined && fields.state !== before.state) {
          const to = await stateById(tx, fields.state)
          changeState(before, to, sets, params, at)
          events.push(
            await appendEvent(tx, id, actor, at, "changed", { field: "state", from: before.state, to: to.id }),
          )
        }
        if (fields.priority !== undefined && fields.priority !== before.priority)
          await change("priority", "priority", fields.priority, { from: before.priority, to: fields.priority })
        if (fields.due !== undefined && fields.due !== before.due)
          await change("due", "due", fields.due, { from: before.due, to: fields.due })
        if (fields.parent !== undefined && fields.parent !== before.parent)
          await change("parent", "parent", fields.parent, { from: before.parent, to: fields.parent })
        if (fields.labels !== undefined && !same(fields.labels, before.labels))
          await change("labels", "labels", JSON.stringify(fields.labels), { from: before.labels, to: fields.labels })
        if (fields.assignees !== undefined && !same(fields.assignees, before.assignees)) {
          await change("assignees", "assignees", JSON.stringify(fields.assignees), {
            from: before.assignees,
            to: fields.assignees,
          })
          await syncAssignees(tx, id, before.assignees, fields.assignees)
        }
        if (fields.threads !== undefined && !same(fields.threads, before.threads))
          await change("threads", "threads", JSON.stringify(fields.threads), {
            from: before.threads,
            to: fields.threads,
          })
        if (fields.prs !== undefined && !same(fields.prs, before.prs))
          await change("prs", "prs", JSON.stringify(fields.prs), { from: before.prs, to: fields.prs })
        if (events.length === 0) return { issue: before, events, wakes: [] }
        await tx.run(`UPDATE issues SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, at, id)
        const issue = issueOf(await requireRow(tx, id))
        return { issue, events, wakes: await queueWakes(tx, issue, events, actor) }
      })
    },

    link: async (actor, id, kind, other, on) => {
      if (id === other) fail("an issue cannot link to itself")
      const scope = await scopeOf(actor)
      const [from, to, stored] =
        kind === "blocks"
          ? [id, other, "blocks"]
          : kind === "blocked_by"
            ? [other, id, "blocks"]
            : [Math.min(id, other), Math.max(id, other), "related"]
      const at = port.now()
      return write(async (tx) => {
        const [mine, theirs] = [await visible(tx, id, scope), await visible(tx, other, scope)]
        if (apart(mine.project, theirs.project)) fail(`#${other} is in another project`)
        const changed = on
          ? await tx.runCounted(
              "INSERT INTO issue_links (from_id, to_id, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
              from,
              to,
              stored,
            )
          : await tx.runCounted(
              "DELETE FROM issue_links WHERE from_id = ? AND to_id = ? AND kind = ?",
              from,
              to,
              stored,
            )
        if (changed === 0) return { issue: issueOf(await requireRow(tx, id)), events: [], wakes: [] }
        const events = [
          await appendEvent(tx, id, actor, at, on ? "linked" : "unlinked", { kind, issue: other }),
          await appendEvent(tx, other, actor, at, on ? "linked" : "unlinked", {
            kind: kind === "blocks" ? "blocked_by" : kind === "blocked_by" ? "blocks" : "related",
            issue: id,
          }),
        ]
        await touch(tx, other, at)
        return { issue: await touch(tx, id, at), events, wakes: [] }
      })
    },

    comment: async (actor, id, input) => {
      const body = input.body.trim()
      if (body.length === 0) fail("a comment needs text")
      within(body, LIMITS.body, "a comment")
      const mentions = unique(input.mentions ?? [], String)
      if (mentions.length > MANY) fail(`at most ${MANY} mentions`)
      const scope = await scopeOf(actor)
      await conversations(mentions, "mention", await projectOfIssue(id), scope)
      const at = port.now()
      return write(async (tx) => {
        await visible(tx, id, scope)
        if (input.replyTo !== undefined) {
          const parent = await tx.get<{ issue_id: number; kind: string; reply_to: number | null }>(
            "SELECT issue_id, kind, reply_to FROM issue_events WHERE id = ?",
            input.replyTo,
          )
          if (parent === undefined || parent.issue_id !== id || parent.kind !== "comment")
            fail(`event ${input.replyTo} is not a comment on #${id}`)
          if (parent?.reply_to !== null) fail("replies go one level deep; reply to the top comment")
        }
        const event = await appendEvent(tx, id, actor, at, "comment", { body, mentions }, input.replyTo ?? null)
        const issue = await touch(tx, id, at)
        return { issue, events: [event], wakes: await queueWakes(tx, issue, [event], actor) }
      })
    },

    pending: async () =>
      (await db.all<WakeRow>("SELECT command_id, issue_id, target, title, status, text FROM issue_wakes")).map(wakeOf),

    delivered: async (commandId) => {
      await db.run("DELETE FROM issue_wakes WHERE command_id = ?", commandId)
    },

    revs: async () => {
      if (revs !== undefined) return revs
      const current = await db.get<{ rev: number | null; statesRev: number | null }>(
        "SELECT (SELECT max(id) FROM issue_events) AS rev, (SELECT value FROM issue_meta WHERE key = 'states_rev') AS statesRev",
      )
      revs = { rev: current?.rev ?? 0, statesRev: current?.statesRev ?? 0 }
      return revs
    },
  }
}
