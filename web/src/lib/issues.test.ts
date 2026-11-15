import { expect, test } from "bun:test"
import { OpError } from "./api.ts"
import {
  actorName,
  assigneeCandidates,
  assigneesEdit,
  closedGroups,
  descriptionEdit,
  dueEdit,
  issueIdOf,
  linkArgs,
  titleEdit,
  withHead,
  withOlder,
  type IssueDetail,
  assigneeName,
  dueLabel,
  eventLine,
  initials,
  latestIssue,
  issueScope,
  nextCommandId,
  threadPlace,
  localDay,
  newIssueArgs,
  openGroups,
  parseIssueDetail,
  parseIssuePage,
  parseIssuesRev,
  parseStates,
  stateTone,
  timelineItems,
  type IssueEvent,
  type IssueSummary,
  type Names,
} from "./issues.ts"

const STATES = parseStates({
  states: [
    { id: "todo", name: "Todo", closed: false, position: 4, isDefault: true },
    { id: "needs-you", name: "Needs you", closed: false, position: 2, isDefault: false },
    { id: "in-progress", name: "In progress", closed: false, position: 1, isDefault: false },
    { id: "done", name: "Done", closed: true, position: 6, isDefault: true },
    { name: "broken" },
  ],
})

function issue(id: number, state: string, priority: IssueSummary["priority"] = "normal"): IssueSummary {
  return { id, title: `Issue ${id}`, state, priority, due: null, parent: null, assignees: [], threads: [], prs: [], updatedAt: 0 }
}

const NAMES: Names = {
  thread: (id) => (id === 7 ? "Fix the build" : undefined),
  captain: (id) => (id === 1 ? "Bosun" : undefined),
}

test("states parse in position order and drop malformed rows", () => {
  expect(STATES.map((state) => state.id)).toEqual(["in-progress", "needs-you", "todo", "done"])
})

test("open groups put Needs you first, then state order, and skip closed and empty states", () => {
  const groups = openGroups(STATES, [issue(1, "todo"), issue(2, "done"), issue(3, "needs-you"), issue(4, "in-progress")])
  expect(groups.map((group) => [group.state.id, group.issues.map((entry) => entry.id)])).toEqual([
    ["needs-you", [3]],
    ["in-progress", [4]],
    ["todo", [1]],
  ])
})

test("an issue in a state the client has not read waits in a fallback group after the known ones", () => {
  const groups = openGroups(STATES, [issue(1, "qa"), issue(2, "todo"), issue(3, "qa", "urgent"), issue(4, "triage")])
  expect(groups.map((group) => [group.state.id, group.state.name, group.issues.map((entry) => entry.id)])).toEqual([
    ["todo", "Todo", [2]],
    ["qa", "qa", [3, 1]],
    ["triage", "triage", [4]],
  ])
  expect(groups.reduce((sum, group) => sum + group.issues.length, 0)).toBe(4)
})

test("inside a state, higher priority comes first and ties keep the list order", () => {
  const groups = openGroups(STATES, [issue(1, "todo", "low"), issue(2, "todo"), issue(3, "todo", "urgent"), issue(4, "todo")])
  expect(groups[0]?.issues.map((entry) => entry.id)).toEqual([3, 2, 4, 1])
})

test("the issue page parses the contract's summary and defaults what is missing", () => {
  const [parsed] = parseIssuePage({
    issues: [
      {
        id: 9,
        title: "Ship it",
        state: "todo",
        priority: "weird",
        due: "2026-11-20",
        parent: null,
        assignees: [{ kind: "person", id: "owner" }, { kind: "captain", id: 1 }, { kind: "thread", id: "x" }],
        threads: [7, "8"],
        prs: ["https://example.com/pr/1"],
        updatedAt: 5,
      },
      { id: "bad" },
    ],
    cursor: null,
  })
  expect(parsed).toEqual({
    id: 9,
    title: "Ship it",
    state: "todo",
    priority: "normal",
    due: "2026-11-20",
    parent: null,
    assignees: [
      { kind: "person", id: "owner" },
      { kind: "captain", id: 1 },
    ],
    threads: [7],
    prs: ["https://example.com/pr/1"],
    updatedAt: 5,
  })
})

test("the detail parses links, the timeline and whether older events exist", () => {
  const detail = parseIssueDetail({
    issue: { id: 1, title: "A", state: "todo", priority: "high", description: "Body" },
    children: [{ id: 2, title: "B", state: "todo" }],
    links: { blocks: [{ id: 3, title: "C", state: "todo" }], blockedBy: [], related: [{ id: 4 }] },
    timeline: [{ id: 10, issue: 1, at: 1, actor: "person:owner", kind: "created", data: {}, replyTo: null }, { id: 11, kind: "nope" }],
    earlier: 9,
  })
  expect(detail?.issue.description).toBe("Body")
  expect(detail?.children.map((child) => child.id)).toEqual([2])
  expect(detail?.links).toEqual({ blocks: [{ id: 3, title: "C", state: "todo" }], blockedBy: [], related: [] })
  expect(detail?.timeline.map((event) => event.id)).toEqual([10])
  expect(detail?.earlier).toBe(9)
  expect(parseIssueDetail({ issue: { id: 1 } })).toBeUndefined()
})

test("the home revision reads issues.rev and falls back to zero", () => {
  expect(parseIssuesRev({ projects: [], issues: { rev: 42 } })).toBe(42)
  expect(parseIssuesRev({ projects: [] })).toBe(0)
})

test("state tones cover the seeded states and fall back on closed for the owner's own", () => {
  expect(stateTone(STATES[1])).toBe("needs")
  expect(stateTone({ id: "shipped", name: "Shipped", closed: true, position: 9, isDefault: false })).toBe("done")
  expect(stateTone({ id: "triage", name: "Triage", closed: false, position: 9, isDefault: false })).toBe("todo")
  expect(stateTone(undefined)).toBe("todo")
})

test("due labels name today, drop this year, and flag overdue dates", () => {
  const today = localDay(new Date(2026, 10, 16))
  expect(today).toBe("2026-11-16")
  expect(dueLabel("2026-11-16", today)).toEqual({ text: "Today", overdue: false })
  expect(dueLabel("2026-11-20", today)).toEqual({ text: "Nov 20", overdue: false })
  expect(dueLabel("2026-11-02", today)).toEqual({ text: "Nov 2", overdue: true })
  expect(dueLabel("2027-01-05", today)).toEqual({ text: "Jan 5 2027", overdue: false })
  expect(dueLabel(null, today)).toBeUndefined()
  expect(dueLabel("soon", today)).toBeUndefined()
})

test("assignees and actors resolve to the names the home lists", () => {
  expect(assigneeName({ kind: "person", id: "owner" }, NAMES)).toBe("You")
  expect(assigneeName({ kind: "thread", id: 7 }, NAMES)).toBe("Fix the build")
  expect(assigneeName({ kind: "captain", id: 1 }, NAMES)).toBe("Bosun")
  expect(assigneeName({ kind: "thread", id: 99 }, NAMES)).toBe("Thread 99")
  expect(actorName("person:owner", NAMES)).toBe("You")
  expect(actorName("thread:7", NAMES)).toBe("Fix the build")
  expect(actorName("thread:1", NAMES)).toBe("Bosun")
  expect(initials("Fix the build")).toBe("FT")
  expect(initials("bosun")).toBe("B")
  expect(initials(" ")).toBe("?")
})

function event(id: number, kind: IssueEvent["kind"], data: IssueEvent["data"] = {}, replyTo: number | null = null): IssueEvent {
  return { id, at: id, actor: "person:owner", kind, data, replyTo }
}

test("timeline lines describe each change in words", () => {
  const name = (id: string): string => (id === "todo" ? "Todo" : id === "done" ? "Done" : id)
  expect(eventLine(event(1, "created"), "You", name)).toBe("You created this issue")
  expect(eventLine(event(2, "changed", { field: "state", from: "todo", to: "done" }), "You", name)).toBe("You moved this from Todo to Done")
  expect(eventLine(event(3, "changed", { field: "priority", from: "normal", to: "urgent" }), "You", name)).toBe("You set the priority to Urgent")
  expect(eventLine(event(4, "changed", { field: "due", from: "2026-11-01", to: null }), "You", name)).toBe("You cleared the due date")
  expect(eventLine(event(5, "changed", { field: "description" }), "You", name)).toBe("You changed the description")
  expect(eventLine(event(6, "linked", { kind: "blocked_by", issue: 4 }), "Bosun", name)).toBe("Bosun marked this as blocked by #4")
  expect(eventLine(event(7, "unlinked", { kind: "related", issue: 4 }), "You", name)).toBe("You removed the link to #4")
})

test("replies nest under their comment, and an orphaned reply stands alone", () => {
  const items = timelineItems([
    event(1, "created"),
    event(2, "comment", { body: "first" }),
    event(3, "comment", { body: "reply" }, 2),
    event(4, "comment", { body: "orphan" }, 99),
  ])
  expect(items.map((item) => (item.kind === "comment" ? [item.event.id, item.replies.map((reply) => reply.id)] : item.event.id))).toEqual([
    1,
    [2, [3]],
    [4, []],
  ])
})

test("new issue args need a title and carry only the options that were picked", () => {
  expect(newIssueArgs({ title: "  ", project: "p1" })).toBeUndefined()
  expect(newIssueArgs({ title: " Ship ", project: "p1" })).toEqual({ title: "Ship", project: "p1" })
  expect(newIssueArgs({ title: "Ship", project: "p1", priority: "high", state: "needs-you" })).toEqual({
    title: "Ship",
    project: "p1",
    priority: "high",
    state: "needs-you",
  })
})

test("closed groups list only closed states with issues, in state order", () => {
  const states = parseStates({
    states: [
      { id: "todo", name: "Todo", closed: false, position: 0 },
      { id: "canceled", name: "Canceled", closed: true, position: 7 },
      { id: "done", name: "Done", closed: true, position: 6 },
    ],
  })
  const groups = closedGroups(states, [issue(1, "canceled"), issue(2, "done"), issue(3, "todo")])
  expect(groups.map((group) => [group.state.id, group.issues.map((entry) => entry.id)])).toEqual([
    ["done", [2]],
    ["canceled", [1]],
  ])
})

test("title and description edits trim, refuse an empty title and skip no-ops", () => {
  expect(titleEdit("Ship", " Ship ")).toEqual({ kind: "same" })
  expect(titleEdit("Ship", "  ")).toEqual({ kind: "invalid", message: "A title cannot be empty" })
  expect(titleEdit("Ship", " Ship it ")).toEqual({ kind: "send", fields: { title: "Ship it" } })
  expect(descriptionEdit("Body", "Body\n\n")).toEqual({ kind: "same" })
  expect(descriptionEdit("Body", "")).toEqual({ kind: "send", fields: { description: "" } })
})

test("due edits send the date, null for Clear, and nothing when unchanged", () => {
  expect(dueEdit(null, "2026-11-20")).toEqual({ kind: "send", fields: { due: "2026-11-20" } })
  expect(dueEdit("2026-11-20", "")).toEqual({ kind: "send", fields: { due: null } })
  expect(dueEdit(null, "")).toEqual({ kind: "same" })
  expect(dueEdit("2026-11-20", "2026-11-20")).toEqual({ kind: "same" })
  expect(dueEdit(null, "11/20")).toEqual({ kind: "invalid", message: "Pick a date" })
})

test("assignee edits send the whole list after one add or remove", () => {
  const owner = { kind: "person", id: "owner" } as const
  const thread = { kind: "thread", id: 7 } as const
  expect(assigneesEdit([owner], { add: thread })).toEqual({ kind: "send", fields: { assignees: [owner, thread] } })
  expect(assigneesEdit([owner, thread], { remove: owner })).toEqual({ kind: "send", fields: { assignees: [thread] } })
  expect(assigneesEdit([owner], { add: { kind: "person", id: "owner" } })).toEqual({ kind: "same" })
  expect(assigneesEdit([owner], { remove: thread })).toEqual({ kind: "same" })
  const full = Array.from({ length: 20 }, (_, id) => ({ kind: "thread", id }) as const)
  expect(assigneesEdit(full, { add: owner })).toEqual({ kind: "invalid", message: "At most 20 assignees" })
})

test("assignee candidates drop who is assigned and match the name or detail", () => {
  const all = [
    { assignee: { kind: "person", id: "owner" } as const, name: "You", detail: "Person" },
    { assignee: { kind: "thread", id: 7 } as const, name: "Fix the build", detail: "Thread" },
    { assignee: { kind: "captain", id: 1 } as const, name: "Bosun", detail: "Captain" },
  ]
  expect(assigneeCandidates(all, [{ kind: "thread", id: 7 }], "").map((entry) => entry.name)).toEqual(["You", "Bosun"])
  expect(assigneeCandidates(all, [], "capt").map((entry) => entry.name)).toEqual(["Bosun"])
  expect(assigneeCandidates(all, [], "build").map((entry) => entry.name)).toEqual(["Fix the build"])
})

test("link entry reads an id, and link args refuse self and duplicate links", () => {
  expect(issueIdOf("#12")).toBe(12)
  expect(issueIdOf(" 12 ")).toBe(12)
  expect(issueIdOf("12a")).toBeUndefined()
  expect(issueIdOf("#0")).toBeUndefined()
  const links = { blocks: [{ id: 3, title: "C", state: "todo" }], blockedBy: [], related: [] }
  expect(linkArgs(1, "blocks", 4, links)).toEqual({ kind: "send", args: { id: 1, kind: "blocks", other: 4 } })
  expect(linkArgs(1, "blocks", 1, links)).toEqual({ kind: "invalid", message: "An issue cannot link to itself" })
  expect(linkArgs(1, "blocks", 3, links)).toEqual({ kind: "invalid", message: "#3 is already listed there" })
  expect(linkArgs(1, "related", 3, links).kind).toBe("send")
})

function page(ids: readonly number[], earlier: number | null): IssueDetail {
  return {
    issue: { ...issue(1, "todo"), description: "" },
    children: [],
    links: { blocks: [], blockedBy: [], related: [] },
    timeline: ids.map((id) => event(id, "created")),
    earlier,
  }
}

test("older pages prepend and take the older cursor; a head re-read merges without gaps and keeps it", () => {
  const head = withHead(undefined, page([101, 102, 103], 101))
  expect(head).toEqual({ events: page([101, 102, 103], null).timeline, cursor: 101, paged: false })
  const older = withOlder(head, page([1, 2, 100], null))
  expect(older.events.map((entry) => entry.id)).toEqual([1, 2, 100, 101, 102, 103])
  expect(older.cursor).toBeNull()
  const moved = withHead(older, page([103, 104, 105], 103))
  expect(moved.events.map((entry) => entry.id)).toEqual([1, 2, 100, 101, 102, 103, 104, 105])
  expect(moved.cursor).toBeNull()
  expect(withHead(head, page([102, 103, 104], 102)).cursor).toBe(102)
})

test("a project pane lists its own issues, and a Captain pane lists its project's", () => {
  expect(issueScope({ id: "prj_1" }, undefined)).toBe("prj_1")
  expect(issueScope({ id: "spc_9" }, { projectId: "prj_1" })).toBe("prj_1")
})

test("a draft keeps its command id across a network failure and gets a new one after a success or a rejection", () => {
  let minted = 0
  const mint = (): string => `id-${(minted += 1)}`
  expect(nextCommandId("id-0", new TypeError("Failed to fetch"), mint)).toBe("id-0")
  expect(nextCommandId("id-0", new OpError("http", "issue.comment: HTTP 502"), mint)).toBe("id-0")
  expect(nextCommandId("id-0", new OpError("bad_args", "a comment needs text"), mint)).toBe("id-1")
  expect(nextCommandId("id-1", undefined, mint)).toBe("id-2")
})

test("a linked thread opens in this pane, under its own project, or not at all when the home does not list it", () => {
  const pane = { id: "prj_a", slug: "alpha", threads: [{ id: 7, title: "Fix the build" }] }
  const other = { id: "prj_b", slug: "beta", threads: [{ id: 9, title: "Draft copy" }] }
  expect(threadPlace(7, pane, [pane, other])).toEqual({ kind: "here", title: "Fix the build" })
  expect(threadPlace(9, pane, [pane, other])).toEqual({ kind: "elsewhere", title: "Draft copy", projectId: "prj_b", slug: "beta" })
  expect(threadPlace(42, pane, [pane, other])).toEqual({ kind: "unknown" })
})

test("a delayed ack never replaces a newer rename the rev already showed", () => {
  const base = { ...issue(1, "todo"), description: "" }
  const ack = { ...base, title: "Alpha one", priority: "low" as const, updatedAt: 100 }
  const renamed = { ...base, title: "Alpha one newest", priority: "low" as const, updatedAt: 160 }
  expect(latestIssue(renamed, ack)).toBe(renamed)
  expect(latestIssue({ ...base, updatedAt: 90 }, ack)).toBe(ack)
  expect(latestIssue(ack, { ...ack })).toEqual(ack)
})
