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
  readonly limit?: number
  readonly cursor?: string
}

export type IssuePage = { readonly issues: IssueSummary[]; readonly cursor: string | null }

export type Change = { readonly issue: Issue; readonly events: IssueEvent[] }

export type Wake = {
  readonly target: number
  readonly commandId: string
  readonly title: string
  readonly text: string
}

export interface IssuesService {
  states(): Promise<IssueState[]>
  createState(input: { readonly name: string; readonly closed: boolean }): Promise<IssueState>
  updateState(input: {
    readonly id: string
    readonly name?: string
    readonly position?: number
    readonly isDefault?: true
  }): Promise<IssueState>
  deleteState(input: { readonly id: string; readonly moveTo: string }): Promise<{ readonly moved: number }>
  create(actor: IssueActor, fields: IssueFields & { readonly title: string }): Promise<Change>
  get(id: number): Promise<IssueDetail | undefined>
  list(filter: IssueFilter): Promise<IssuePage>
  update(actor: IssueActor, id: number, fields: IssueFields): Promise<Change>
  link(actor: IssueActor, id: number, kind: LinkKind, other: number, on: boolean): Promise<Change>
  comment(
    actor: IssueActor,
    id: number,
    input: { readonly body: string; readonly replyTo?: number; readonly mentions?: number[] },
  ): Promise<Change>
  wakes(change: Change, actor: IssueActor): Promise<Wake[]>
  rev(): Promise<number>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    issues: IssuesService
  }
}

export type IssuesPort = {
  readonly db: SqliteDatabase
  conversationExists(id: number): Promise<boolean>
  now(): number
}

const LIST_LIMIT = 50
const LIST_MAX = 200
const TIMELINE_MAX = 500
const MANY = 20
const DATE = /^\d{4}-\d{2}-\d{2}$/
const URL_PATTERN = /^https?:\/\/\S+$/
const WAKE_TEXT_MAX = 2000

type IssueRow = {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly state: string
  readonly priority: string
  readonly due: string | null
  readonly parent: number | null
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

type LinkRow = {
  readonly from_id: number
  readonly kind: string
  readonly id: number
  readonly title: string
  readonly state: string
}

const SUMMARY_COLUMNS =
  "id, title, state, priority, due, parent, labels, assignees, threads, prs, created_at, updated_at, closed_at"

const fail = (message: string): never => {
  throw new OpRejected("bad_args", message)
}

const missing = (what: string): never => {
  throw new OpRejected("bad_args", what)
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

function assigneesOf(json: string): Assignee[] {
  const value: unknown = JSON.parse(json)
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
    labels: strings(row.labels),
    assignees: assigneesOf(row.assignees),
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

const unique = <T>(items: T[], key: (item: T) => string): T[] => {
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
  const tokens = q.match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.length === 0 ? undefined : tokens.map((token) => `"${token}"*`).join(" ")
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const encodeCursor = (issue: IssueSummary): string => `${issue.updatedAt}.${issue.id}`

function decodeCursor(cursor: string): readonly [number, number] {
  const match = /^(\d+)\.(\d+)$/.exec(cursor)
  if (match === null) return fail("cursor is not one this list returned")
  return [Number(match[1]), Number(match[2])]
}

const stateRows = async (q: SqliteExecutor): Promise<StateRow[]> =>
  q.all<StateRow>("SELECT id, name, closed, position, is_default FROM issue_states ORDER BY position, id")

const stateById = async (q: SqliteExecutor, id: string): Promise<StateRow> =>
  (await q.get<StateRow>("SELECT id, name, closed, position, is_default FROM issue_states WHERE id = ?", id)) ??
  fail(`unknown state ${id}`)

const row = async (q: SqliteExecutor, id: number): Promise<IssueRow | undefined> =>
  q.get<IssueRow>(`SELECT ${SUMMARY_COLUMNS}, description FROM issues WHERE id = ?`, id)

const requireRow = async (q: SqliteExecutor, id: number): Promise<IssueRow> =>
  (await row(q, id)) ?? missing(`no issue #${id}`)

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
     RETURNING id, issue_id, at, actor, kind, data, reply_to`,
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

export function createIssues(port: IssuesPort): IssuesService {
  const { db } = port

  const conversations = async (ids: number[], what: string): Promise<void> => {
    for (const id of ids) if (!(await port.conversationExists(id))) fail(`${what} ${id} is not a conversation`)
  }

  const normalize = async (fields: IssueFields, self: number | undefined): Promise<IssueFields> => {
    const title = fields.title?.trim()
    if (title !== undefined && title.length === 0) fail("a title cannot be empty")
    if (fields.due !== undefined && fields.due !== null && !DATE.test(fields.due)) fail("due must be YYYY-MM-DD")
    if (fields.state !== undefined) await stateById(db, fields.state)
    const labels =
      fields.labels === undefined
        ? undefined
        : unique(
            fields.labels.map((label) => label.trim()),
            (l) => l,
          )
    if (labels !== undefined && labels.some((label) => label.length === 0)) fail("a label cannot be empty")
    const assignees = fields.assignees === undefined ? undefined : unique(fields.assignees, assigneeToken)
    if (assignees !== undefined)
      await conversations(
        assignees.flatMap((assignee) => (assignee.kind === "person" ? [] : [assignee.id])),
        "assignee",
      )
    const threads = fields.threads === undefined ? undefined : unique(fields.threads, String)
    if (threads !== undefined) await conversations(threads, "thread")
    const prs = fields.prs === undefined ? undefined : unique(fields.prs, (url) => url)
    if (prs !== undefined && prs.some((url) => !URL_PATTERN.test(url)))
      fail("a pull request link must be an http(s) URL")
    for (const list of [labels, assignees, threads, prs])
      if (list !== undefined && list.length > MANY) fail(`at most ${MANY} entries per list`)
    if (fields.parent !== undefined && fields.parent !== null) {
      if (fields.parent === self) fail("an issue cannot be its own parent")
      const parent = await requireRow(db, fields.parent)
      if (parent.parent !== null) fail(`#${parent.id} is already a sub-issue; sub-issues go one level deep`)
      if (
        self !== undefined &&
        (await db.get<{ id: number }>("SELECT id FROM issues WHERE parent = ? LIMIT 1", self)) !== undefined
      )
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

  const stateName = async (id: unknown): Promise<string> =>
    typeof id === "string"
      ? ((await db.get<{ name: string }>("SELECT name FROM issue_states WHERE id = ?", id))?.name ?? id)
      : "none"

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
      const rows = await stateRows(db)
      const base = slugOf(name)
      let id = base
      for (let n = 2; rows.some((state) => state.id === id); n += 1) id = `${base}-${n}`
      const position = rows.reduce((max, state) => Math.max(max, state.position), -1) + 1
      await db.run(
        "INSERT INTO issue_states (id, name, closed, position, is_default) VALUES (?, ?, ?, ?, 0)",
        id,
        name,
        input.closed ? 1 : 0,
        position,
      )
      return stateOf(await stateById(db, id))
    },

    updateState: async (input) => {
      const state = await stateById(db, input.id)
      const name = input.name?.trim()
      if (name !== undefined && name.length === 0) fail("a state needs a name")
      await db.transaction(async (tx) => {
        if (name !== undefined) await tx.run("UPDATE issue_states SET name = ? WHERE id = ?", name, state.id)
        if (input.position !== undefined) {
          const order = (await stateRows(tx)).filter((other) => other.id !== state.id).map((other) => other.id)
          order.splice(Math.max(0, Math.min(input.position, order.length)), 0, state.id)
          for (const [position, id] of order.entries())
            await tx.run("UPDATE issue_states SET position = ? WHERE id = ? AND position != ?", position, id, position)
        }
        if (input.isDefault === true && state.is_default === 0)
          await tx.run("UPDATE issue_states SET is_default = (id = ?) WHERE closed = ?", state.id, state.closed)
      })
      return stateOf(await stateById(db, state.id))
    },

    deleteState: async (input) => {
      const state = await stateById(db, input.id)
      if (state.is_default === 1) fail(`${state.name} is a default state; make another state the default first`)
      if (input.moveTo === state.id) fail("move its issues to a different state")
      const target = await stateById(db, input.moveTo)
      const at = port.now()
      return db.transaction(async (tx) => {
        const moved = await tx.runCounted(
          `UPDATE issues SET state = ?, updated_at = ?,
             closed_at = CASE WHEN ? = 1 THEN coalesce(closed_at, ?) ELSE NULL END
           WHERE state = ?`,
          target.id,
          at,
          target.closed,
          at,
          state.id,
        )
        await tx.run("DELETE FROM issue_states WHERE id = ?", state.id)
        return { moved }
      })
    },

    create: async (actor, input) => {
      const fields = await normalize(input, undefined)
      const state =
        fields.state === undefined
          ? ((await db.get<StateRow>(
              "SELECT id, name, closed, position, is_default FROM issue_states WHERE is_default = 1 AND closed = 0",
            )) ?? fail("no default state is set"))
          : await stateById(db, fields.state)
      const at = port.now()
      return db.transaction(async (tx) => {
        const created = await tx.get<{ id: number }>(
          `INSERT INTO issues (title, description, state, priority, due, parent, labels, assignees, threads, prs, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          fields.title ?? "",
          fields.description ?? "",
          state.id,
          fields.priority ?? "normal",
          fields.due ?? null,
          fields.parent ?? null,
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
        return { issue: issueOf(await requireRow(tx, created.id)), events: [event] }
      })
    },

    get: async (id) => {
      const found = await row(db, id)
      if (found === undefined) return undefined
      const [children, links, events] = await Promise.all([
        db.all<IssueRow>(`SELECT ${SUMMARY_COLUMNS} FROM issues WHERE parent = ? ORDER BY id`, id),
        linked(id),
        db.all<EventRow>(
          "SELECT id, issue_id, at, actor, kind, data, reply_to FROM issue_events WHERE issue_id = ? ORDER BY id LIMIT ?",
          id,
          TIMELINE_MAX,
        ),
      ])
      return { issue: issueOf(found), children: children.map(summaryOf), links, timeline: events.map(eventOf) }
    },

    list: async (filter) => {
      const where: string[] = []
      const params: SqliteValue[] = []
      if (filter.q !== undefined) {
        const match = ftsQuery(filter.q)
        if (match !== undefined) {
          where.push("id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)")
          params.push(match)
        }
      }
      if (filter.assignee !== undefined) {
        where.push("id IN (SELECT issue_id FROM issue_assignees WHERE assignee = ?)")
        params.push(assigneeToken(filter.assignee))
      }
      if (filter.states !== undefined && filter.states.length > 0) {
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`)
        params.push(...filter.states)
      }
      if (filter.closed !== undefined) where.push(filter.closed ? "closed_at IS NOT NULL" : "closed_at IS NULL")
      if (filter.parent === null) where.push("parent IS NULL")
      else if (filter.parent !== undefined) {
        where.push("parent = ?")
        params.push(filter.parent)
      }
      if (filter.cursor !== undefined) {
        const [updatedAt, id] = decodeCursor(filter.cursor)
        where.push("(updated_at < ? OR (updated_at = ? AND id < ?))")
        params.push(updatedAt, updatedAt, id)
      }
      const limit = Math.max(1, Math.min(filter.limit ?? LIST_LIMIT, LIST_MAX))
      const rows = await db.all<IssueRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM issues ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ...params,
        limit + 1,
      )
      const issues = rows.slice(0, limit).map(summaryOf)
      const last = issues.at(-1)
      return { issues, cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null }
    },

    update: async (actor, id, input) => {
      const before = issueOf(await requireRow(db, id))
      const fields = await normalize(input, id)
      const at = port.now()
      return db.transaction(async (tx) => {
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
          await change("state", "state", to.id, { from: before.state, to: to.id })
          if (to.closed === 1 && before.closedAt === null) {
            sets.push("closed_at = ?")
            params.push(at)
          } else if (to.closed === 0 && before.closedAt !== null) sets.push("closed_at = NULL")
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
        if (events.length === 0) return { issue: before, events }
        await tx.run(`UPDATE issues SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, at, id)
        return { issue: issueOf(await requireRow(tx, id)), events }
      })
    },

    link: async (actor, id, kind, other, on) => {
      if (id === other) fail("an issue cannot link to itself")
      await requireRow(db, id)
      await requireRow(db, other)
      const [from, to, stored] =
        kind === "blocks"
          ? [id, other, "blocks"]
          : kind === "blocked_by"
            ? [other, id, "blocks"]
            : [Math.min(id, other), Math.max(id, other), "related"]
      const at = port.now()
      return db.transaction(async (tx) => {
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
        if (changed === 0) return { issue: issueOf(await requireRow(tx, id)), events: [] }
        const events = [
          await appendEvent(tx, id, actor, at, on ? "linked" : "unlinked", { kind, issue: other }),
          await appendEvent(tx, other, actor, at, on ? "linked" : "unlinked", {
            kind: kind === "blocks" ? "blocked_by" : kind === "blocked_by" ? "blocks" : "related",
            issue: id,
          }),
        ]
        await touch(tx, other, at)
        return { issue: await touch(tx, id, at), events }
      })
    },

    comment: async (actor, id, input) => {
      const body = input.body.trim()
      if (body.length === 0) fail("a comment needs text")
      await requireRow(db, id)
      if (input.replyTo !== undefined) {
        const parent = await db.get<{ issue_id: number; kind: string; reply_to: number | null }>(
          "SELECT issue_id, kind, reply_to FROM issue_events WHERE id = ?",
          input.replyTo,
        )
        if (parent === undefined || parent.issue_id !== id || parent.kind !== "comment")
          fail(`event ${input.replyTo} is not a comment on #${id}`)
        if (parent?.reply_to !== null) fail("replies go one level deep; reply to the top comment")
      }
      const mentions = unique(input.mentions ?? [], String)
      if (mentions.length > MANY) fail(`at most ${MANY} mentions`)
      await conversations(mentions, "mention")
      const at = port.now()
      return db.transaction(async (tx) => {
        const event = await appendEvent(tx, id, actor, at, "comment", { body, mentions }, input.replyTo ?? null)
        return { issue: await touch(tx, id, at), events: [event] }
      })
    },

    wakes: async (change, actor) => {
      const self = assigneeToken(actor)
      const issue = change.issue
      const owner = issue.threads[0]
      const wakes = new Map<number, Wake>()
      const add = (target: number | undefined, event: IssueEvent, text: string): void => {
        if (target === undefined || `thread:${target}` === self || `captain:${target}` === self || wakes.has(target))
          return
        wakes.set(target, {
          target,
          commandId: `issue:${event.id}:${target}`,
          title: `#${issue.id} ${issue.title}`,
          text: `${text.length > WAKE_TEXT_MAX ? `${text.slice(0, WAKE_TEXT_MAX)}…` : text}\nOpen issue #${issue.id} for the full record.`,
        })
      }
      for (const event of change.events) {
        if (event.kind === "comment") {
          const body = typeof event.data["body"] === "string" ? event.data["body"] : ""
          const text = `${event.actor} commented${event.replyTo === null ? "" : " in a reply"}: ${body}`
          add(owner, event, text)
          const mentioned = Array.isArray(event.data["mentions"]) ? event.data["mentions"] : []
          for (const target of mentioned)
            if (typeof target === "number") add(target, event, `${event.actor} mentioned you: ${body}`)
        }
        if (event.kind === "changed" && event.data["field"] === "state")
          add(
            owner,
            event,
            `${event.actor} moved it from ${await stateName(event.data["from"])} to ${await stateName(event.data["to"])}.`,
          )
        if (event.kind === "changed" && event.data["field"] === "assignees") {
          const names = issue.assignees.map(assigneeToken)
          add(owner, event, `${event.actor} set the assignees to ${names.length === 0 ? "nobody" : names.join(", ")}.`)
          const before = new Set(
            Array.isArray(event.data["from"]) ? assigneesOf(JSON.stringify(event.data["from"])).map(assigneeToken) : [],
          )
          for (const assignee of issue.assignees)
            if (assignee.kind !== "person" && !before.has(assigneeToken(assignee)))
              add(assignee.id, event, `${event.actor} assigned you.`)
        }
      }
      return [...wakes.values()]
    },

    rev: async () => (await db.get<{ rev: number | null }>("SELECT max(id) AS rev FROM issue_events"))?.rev ?? 0,
  }
}
