import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { type Ack, cmd, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { Issue, IssueDetail, IssuePage, IssueState } from "./issues.ts"

let seq = 0
const call = (stub: Stub, op: string, args: unknown = {}): Promise<Ack> => cmd(stub, `issues-${(seq += 1)}`, op, args)

async function ok<T>(stub: Stub, op: string, args: unknown = {}): Promise<T> {
  const ack = await call(stub, op, args)
  if (!ack.ok) throw new Error(`${op} failed: ${JSON.stringify(ack.error)}`)
  return ack.result as T
}

async function rejected(stub: Stub, op: string, args: unknown): Promise<string> {
  const ack = await call(stub, op, args)
  expect(ack.ok, JSON.stringify(ack)).toBe(false)
  return ack.error?.message ?? ""
}

async function conversations(stub: Stub): Promise<{ readonly root: number; readonly coordinator: number }> {
  const project = await ok<{ coordinatorId: number }>(stub, "project.create", { slug: "work", name: "Work" })
  const root = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
  return { root, coordinator: project.coordinatorId }
}

const jobs = (stub: Stub) =>
  runInDurableObject(stub, async (home: Home) =>
    (await home.intake())
      .filter((item) => item.kind === "job")
      .map((item) => ({
        target: item.target,
        commandId: item.commandId,
        body: item.body,
      })),
  )

describe("issue states", () => {
  it("ships the default states and lets the owner add, rename, reorder, re-default and delete them", async () => {
    const stub = fresh()
    const { states } = await ok<{ states: IssueState[] }>(stub, "issue.states")
    expect(states.map((state) => state.name)).toEqual([
      "Needs you",
      "In review",
      "In progress",
      "Waiting",
      "Todo",
      "Backlog",
      "Done",
      "Canceled",
    ])
    expect(states.filter((state) => state.isDefault).map((state) => state.id)).toEqual(["todo", "done"])

    const triage = await ok<IssueState>(stub, "issue.state.create", { name: "Triage" })
    expect(triage).toMatchObject({ id: "triage", closed: false, isDefault: false, position: 8 })
    await ok(stub, "issue.state.update", { id: "triage", name: "Triage queue", position: 0, isDefault: true })
    const after = (await ok<{ states: IssueState[] }>(stub, "issue.states")).states
    expect(after[0]).toMatchObject({ id: "triage", name: "Triage queue", isDefault: true })
    expect(after.find((state) => state.id === "todo")?.isDefault).toBe(false)

    const issue = await ok<Issue>(stub, "issue.create", { title: "Fresh" })
    expect(issue.state).toBe("triage")
    expect(await rejected(stub, "issue.state.delete", { id: "triage", moveTo: "todo" })).toContain("default")
    expect(await ok(stub, "issue.state.delete", { id: "backlog", moveTo: "todo" })).toEqual({ moved: 0 })
    await ok(stub, "issue.update", { id: issue.id, state: "waiting" })
    expect(await ok(stub, "issue.state.delete", { id: "waiting", moveTo: "done" })).toEqual({ moved: 1 })
    const moved = await ok<IssueDetail>(stub, "issue.get", { id: issue.id })
    expect(moved.issue.state).toBe("done")
    expect(moved.issue.closedAt).not.toBeNull()
  })
})

describe("issues", () => {
  it("keeps every field, closes and reopens, and records each change on the timeline", async () => {
    const stub = fresh()
    const { coordinator } = await conversations(stub)
    const issue = await ok<Issue>(stub, "issue.create", {
      title: "  Ship issues  ",
      description: "The whole tracker",
      priority: "high",
      due: "2026-11-20",
      labels: ["backend", "backend", "cost"],
      assignees: [
        { kind: "person", id: "owner" },
        { kind: "captain", id: coordinator },
      ],
      prs: ["https://github.com/keyurbodar/xin/pull/9"],
    })
    expect(issue).toMatchObject({
      title: "Ship issues",
      state: "todo",
      priority: "high",
      due: "2026-11-20",
      labels: ["backend", "cost"],
      closedAt: null,
    })

    const done = await ok<Issue>(stub, "issue.update", { id: issue.id, state: "done", due: null, priority: "high" })
    expect(done.closedAt).not.toBeNull()
    expect(done.due).toBeNull()
    const reopened = await ok<Issue>(stub, "issue.update", { id: issue.id, state: "in-progress" })
    expect(reopened.closedAt).toBeNull()

    const detail = await ok<IssueDetail>(stub, "issue.get", { id: issue.id })
    expect(detail.issue.description).toBe("The whole tracker")
    expect(detail.timeline.map((event) => [event.kind, event.data["field"] ?? null])).toEqual([
      ["created", null],
      ["changed", "state"],
      ["changed", "due"],
      ["changed", "state"],
    ])
    expect(detail.timeline.every((event) => event.actor === "person:owner")).toBe(true)

    expect(await rejected(stub, "issue.update", { id: issue.id, due: "next week" })).toContain("YYYY-MM-DD")
    expect(await rejected(stub, "issue.update", { id: issue.id, state: "nope" })).toContain("unknown state")
    expect(await rejected(stub, "issue.update", { id: issue.id, threads: [987654] })).toContain("not a conversation")
    expect(await rejected(stub, "issue.update", { id: issue.id, prs: ["xin#9"] })).toContain("URL")
  })

  it("nests sub-issues one level deep and links blocks, blocked-by and related both ways", async () => {
    const stub = fresh()
    const parent = await ok<Issue>(stub, "issue.create", { title: "Parent" })
    const child = await ok<Issue>(stub, "issue.create", { title: "Child", parent: parent.id })
    const other = await ok<Issue>(stub, "issue.create", { title: "Other" })
    expect(await rejected(stub, "issue.create", { title: "Grandchild", parent: child.id })).toContain("one level")
    expect(await rejected(stub, "issue.update", { id: parent.id, parent: other.id })).toContain("has sub-issues")
    expect(await rejected(stub, "issue.update", { id: other.id, parent: other.id })).toContain("own parent")

    await ok(stub, "issue.link", { id: parent.id, kind: "blocks", other: other.id })
    await ok(stub, "issue.link", { id: parent.id, kind: "blocked_by", other: child.id })
    await ok(stub, "issue.link", { id: other.id, kind: "related", other: child.id })
    await ok(stub, "issue.link", { id: child.id, kind: "related", other: other.id })

    const view = await ok<IssueDetail>(stub, "issue.get", { id: parent.id })
    expect(view.children.map((issue) => issue.title)).toEqual(["Child"])
    expect(view.links.blocks.map((issue) => issue.id)).toEqual([other.id])
    expect(view.links.blockedBy.map((issue) => issue.id)).toEqual([child.id])
    const otherView = await ok<IssueDetail>(stub, "issue.get", { id: other.id })
    expect(otherView.links.blockedBy.map((issue) => issue.id)).toEqual([parent.id])
    expect(otherView.links.related.map((issue) => issue.id)).toEqual([child.id])
    expect(otherView.timeline.filter((event) => event.kind === "linked").length).toBe(2)

    await ok(stub, "issue.unlink", { id: other.id, kind: "blocked_by", other: parent.id })
    expect((await ok<IssueDetail>(stub, "issue.get", { id: parent.id })).links.blocks).toEqual([])
  })

  it("threads comment replies one level deep", async () => {
    const stub = fresh()
    const issue = await ok<Issue>(stub, "issue.create", { title: "Talk" })
    const top = await ok<{ event: { id: number } }>(stub, "issue.comment", { id: issue.id, body: "First" })
    const reply = await ok<{ event: { id: number; replyTo: number } }>(stub, "issue.comment", {
      id: issue.id,
      body: "Answer",
      replyTo: top.event.id,
    })
    expect(reply.event.replyTo).toBe(top.event.id)
    expect(await rejected(stub, "issue.comment", { id: issue.id, body: "Deeper", replyTo: reply.event.id })).toContain(
      "one level",
    )
    const other = await ok<Issue>(stub, "issue.create", { title: "Elsewhere" })
    expect(await rejected(stub, "issue.comment", { id: other.id, body: "x", replyTo: top.event.id })).toContain(
      "not a comment",
    )
    const detail = await ok<IssueDetail>(stub, "issue.get", { id: issue.id })
    expect(detail.timeline.filter((event) => event.kind === "comment").map((event) => event.data["body"])).toEqual([
      "First",
      "Answer",
    ])
  })
})

describe("issue search and filters", () => {
  it("searches titles and descriptions and filters by assignee, state, closed and parent, a page at a time", async () => {
    const stub = fresh()
    const { coordinator } = await conversations(stub)
    const epic = await ok<Issue>(stub, "issue.create", { title: "Billing epic", description: "invoices and receipts" })
    await ok(stub, "issue.create", {
      title: "Invoice export",
      parent: epic.id,
      assignees: [{ kind: "thread", id: coordinator }],
    })
    await ok(stub, "issue.create", { title: "Receipt email", parent: epic.id, state: "done" })
    await ok(stub, "issue.create", { title: "Unrelated chore", state: "backlog" })

    const titles = async (args: unknown) =>
      (await ok<IssuePage>(stub, "issue.list", args)).issues.map((issue) => issue.title).toSorted()

    expect(await titles({ q: "invoice" })).toEqual(["Billing epic", "Invoice export"])
    expect(await titles({ q: "recei" })).toEqual(["Billing epic", "Receipt email"])
    expect(await titles({ assignee: { kind: "thread", id: coordinator } })).toEqual(["Invoice export"])
    expect(await titles({ states: ["backlog", "done"] })).toEqual(["Receipt email", "Unrelated chore"])
    expect(await titles({ closed: false, parent: epic.id })).toEqual(["Invoice export"])
    expect(await titles({ parent: null })).toEqual(["Billing epic", "Unrelated chore"])
    expect(await titles({ q: "???" })).toHaveLength(4)

    const first = await ok<IssuePage>(stub, "issue.list", { limit: 3 })
    expect(first.issues).toHaveLength(3)
    expect(first.cursor).not.toBeNull()
    const second = await ok<IssuePage>(stub, "issue.list", { limit: 3, cursor: first.cursor })
    expect(second.issues.map((issue) => issue.title)).toEqual(["Billing epic"])
    expect(second.cursor).toBeNull()
  })
})

describe("issue wakes", () => {
  it("wakes the owning thread on comments, state and assignee changes, and mentioned threads on mentions", async () => {
    const stub = fresh()
    const { root, coordinator } = await conversations(stub)
    const issue = await ok<Issue>(stub, "issue.create", { title: "Wake me", threads: [coordinator] })
    expect(await jobs(stub)).toEqual([])

    await ok(stub, "issue.update", { id: issue.id, labels: ["quiet"], priority: "low" })
    expect(await jobs(stub)).toEqual([])

    await ok(stub, "issue.update", { id: issue.id, state: "in-review" })
    await ok(stub, "issue.comment", { id: issue.id, body: "Looks good", mentions: [root, coordinator] })
    await ok(stub, "issue.update", { id: issue.id, assignees: [{ kind: "thread", id: root }] })
    const woken = await jobs(stub)
    expect(woken.map((job) => job.target)).toEqual([coordinator, coordinator, root, coordinator, root])
    expect(new Set(woken.map((job) => job.commandId)).size).toBe(woken.length)
    expect(woken[0]?.body).toContain("moved it from Todo to In review")
    expect(woken[1]?.body).toContain("person:owner commented: Looks good")
    expect(woken[2]?.body).toContain("mentioned you")
    expect(woken[3]?.body).toContain("set the assignees to thread:")
    expect(woken[4]?.body).toContain("assigned you")
  })

  it("does not wake a thread for its own change", async () => {
    const stub = fresh()
    const { coordinator } = await conversations(stub)
    const issue = await ok<Issue>(stub, "issue.create", { title: "Mine", threads: [coordinator] })
    await runInDurableObject(stub, async (home: Home) => {
      const issues = home.loader.ctx.get("issues")
      if (issues === undefined) throw new Error("no issues service")
      await issues.comment({ kind: "thread", id: coordinator }, issue.id, { body: "progress note" })
      await issues.update({ kind: "thread", id: coordinator }, issue.id, { state: "in-progress" })
    })
    expect(await jobs(stub)).toEqual([])
  })

  it("publishes a home revision that moves with every change", async () => {
    const stub = fresh()
    const rev = () =>
      runInDurableObject(stub, async (home: Home) => {
        const snapshot = await home.loader.ctx.wire.snapshot()
        return (snapshot["issues"] as { rev: number }).rev
      })
    expect(await rev()).toBe(0)
    const issue = await ok<Issue>(stub, "issue.create", { title: "Rev" })
    const created = await rev()
    await ok(stub, "issue.comment", { id: issue.id, body: "bump" })
    expect(await rev()).toBeGreaterThan(created)
  })
})
