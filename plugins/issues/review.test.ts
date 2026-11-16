import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { addThreads, type Ack, cmd, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { Issue, IssueActor, IssueDetail, IssuePage, IssuesService } from "./issues.ts"

let seq = 0
const call = (stub: Stub, op: string, args: unknown = {}): Promise<Ack> => cmd(stub, `review-${(seq += 1)}`, op, args)

async function ok<T>(stub: Stub, op: string, args: unknown = {}): Promise<T> {
  const ack = await call(stub, op, args)
  if (!ack.ok) throw new Error(`${op} failed: ${JSON.stringify(ack.error)}`)
  return ack.result as T
}

type Project = { readonly id: string; readonly coordinatorId: number }

const project = (stub: Stub, slug: string) => ok<Project>(stub, "project.create", { slug, name: slug })

const withIssues = <T>(stub: Stub, work: (issues: IssuesService, home: Home) => Promise<T>): Promise<T> =>
  runInDurableObject(stub, async (home: Home) => {
    const issues = home.loader.ctx.get("issues")
    if (issues === undefined) throw new Error("no issues service")
    return work(issues, home)
  })

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected a refusal")
}

const jobs = (stub: Stub) =>
  runInDurableObject(stub, async (home: Home) =>
    (await home.intake())
      .filter((item) => item.kind === "job")
      .map((item) => ({ target: item.target, body: item.body })),
  )

const thread = (id: number): IssueActor => ({ kind: "thread", id })

const storedRow = (stub: Stub, title: string, stored: string): Promise<void> =>
  runInDurableObject(stub, async (home: Home) => {
    await home.db.run(
      "INSERT INTO issues (title, state, project, created_at, updated_at) VALUES (?, 'todo', ?, ?, ?)",
      title,
      stored,
      Date.now(),
      Date.now(),
    )
  })

const storedProject = (stub: Stub, id: number): Promise<string | null | undefined> =>
  runInDurableObject(
    stub,
    async (home: Home) =>
      (await home.db.get<{ project: string | null }>("SELECT project FROM issues WHERE id = ?", id))?.project,
  )

describe("issue project references", () => {
  it("stores the project id when created by slug, so the project's Overview list counts it", async () => {
    const stub = fresh()
    const ingle = await project(stub, "ingle")
    expect(ingle.id).not.toBe("ingle")
    const issue = await ok<Issue>(stub, "issue.create", { title: "By slug", project: "ingle" })
    expect(issue.project).toBe(ingle.id)
    expect(await storedProject(stub, issue.id)).toBe(ingle.id)
    const overview = await ok<IssuePage>(stub, "issue.list", { project: ingle.id, closed: false, limit: 200 })
    expect(overview.issues.map((found) => found.id)).toEqual([issue.id])
    const bySlug = await ok<IssuePage>(stub, "issue.list", { project: "ingle" })
    expect(bySlug.issues.map((found) => found.id)).toEqual([issue.id])
    const unknown = await call(stub, "issue.create", { title: "Nowhere", project: "nowhere" })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatchObject({ code: "bad_args" })
    expect((await ok<IssuePage>(stub, "issue.list", {})).issues).toHaveLength(1)
  })

  it("rewrites a legacy row that stored a slug to the project id at boot", async () => {
    const stub = fresh()
    const ingle = await project(stub, "ingle")
    await storedRow(stub, "Legacy", "ingle")
    const legacy = (await ok<IssuePage>(stub, "issue.list", {})).issues[0]
    if (legacy === undefined) throw new Error("no legacy row")
    expect(await storedProject(stub, legacy.id)).toBe("ingle")
    await evictDurableObject(stub)
    expect(await storedProject(stub, legacy.id)).toBe(ingle.id)
    const overview = await ok<IssuePage>(stub, "issue.list", { project: ingle.id, closed: false, limit: 200 })
    expect(overview.issues.map((found) => found.id)).toEqual([legacy.id])
  })
})

describe("issue scope", () => {
  it("keeps an agent inside its own project and leaves owner ops unscoped", async () => {
    const stub = fresh()
    const a = await project(stub, "alpha")
    const b = await project(stub, "beta")
    const mine = await ok<Issue>(stub, "issue.create", { title: "Alpha work", threads: [a.coordinatorId] })
    expect(mine.project).toBe(a.id)

    await withIssues(stub, async (issues) => {
      const intruder = thread(b.coordinatorId)
      expect(await issues.get(intruder, mine.id)).toBeUndefined()
      expect(await refusal(issues.update(intruder, mine.id, { state: "done" }))).toContain(`no issue #${mine.id}`)
      expect(await refusal(issues.comment(intruder, mine.id, { body: "hi" }))).toContain(`no issue #${mine.id}`)
      expect((await issues.list(intruder, {})).issues).toEqual([])
      const own = await issues.create(intruder, { title: "Beta work" })
      expect(own.issue.project).toBe(b.id)
      expect(
        await refusal(issues.comment(intruder, own.issue.id, { body: "x", mentions: [a.coordinatorId] })),
      ).toContain("outside this project")
      expect(
        await refusal(issues.update(intruder, own.issue.id, { assignees: [{ kind: "thread", id: a.coordinatorId }] })),
      ).toContain("outside this project")
      expect(await refusal(issues.update(intruder, own.issue.id, { parent: mine.id }))).toContain(
        `no issue #${mine.id}`,
      )
      expect(await refusal(issues.link(intruder, own.issue.id, "related", mine.id, true))).toContain(
        `no issue #${mine.id}`,
      )
    })
    expect(await jobs(stub)).toEqual([])
    expect((await ok<IssuePage>(stub, "issue.list", {})).issues).toHaveLength(2)
    expect((await ok<IssuePage>(stub, "issue.list", { project: a.id })).issues.map((issue) => issue.id)).toEqual([
      mine.id,
    ])
  })
})

describe("issue cross-project writes", () => {
  it("refuses another project's conversations, parents and links on owner ops too", async () => {
    const stub = fresh()
    const a = await project(stub, "east")
    const b = await project(stub, "west")
    const east = await ok<Issue>(stub, "issue.create", { title: "East", project: a.id })
    const west = await ok<Issue>(stub, "issue.create", { title: "West", project: b.id })
    const free = await ok<Issue>(stub, "issue.create", { title: "Home-wide" })
    const refused = async (op: string, args: unknown) => {
      const ack = await call(stub, op, args)
      expect(ack.ok, JSON.stringify(ack)).toBe(false)
      return ack.error?.message ?? ""
    }
    expect(
      await refused("issue.update", { id: east.id, assignees: [{ kind: "captain", id: b.coordinatorId }] }),
    ).toContain("outside this project")
    expect(await refused("issue.update", { id: east.id, threads: [b.coordinatorId] })).toContain("outside this project")
    expect(await refused("issue.comment", { id: east.id, body: "x", mentions: [b.coordinatorId] })).toContain(
      "outside this project",
    )
    expect(await refused("issue.create", { title: "Mixed", threads: [a.coordinatorId, b.coordinatorId] })).toContain(
      "outside this project",
    )
    expect(await refused("issue.update", { id: east.id, parent: west.id })).toContain("another project")
    expect(await refused("issue.link", { id: east.id, kind: "related", other: west.id })).toContain("another project")
    await ok(stub, "issue.update", { id: east.id, assignees: [{ kind: "captain", id: a.coordinatorId }] })
    await ok(stub, "issue.link", { id: east.id, kind: "blocks", other: free.id })
    await ok(stub, "issue.update", { id: free.id, threads: [b.coordinatorId] })
  })
})

describe("issue writes under concurrency", () => {
  it("never lets two re-parentings form a cycle", async () => {
    const stub = fresh()
    const x = await ok<Issue>(stub, "issue.create", { title: "X" })
    const y = await ok<Issue>(stub, "issue.create", { title: "Y" })
    const owner: IssueActor = { kind: "person", id: "owner" }
    const outcomes = await withIssues(stub, (issues) =>
      Promise.allSettled([issues.update(owner, x.id, { parent: y.id }), issues.update(owner, y.id, { parent: x.id })]),
    )
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const parents = await Promise.all(
      [x.id, y.id].map(async (id) => (await ok<IssueDetail>(stub, "issue.get", { id })).issue.parent),
    )
    expect(parents.filter((parent) => parent !== null)).toHaveLength(1)
  })

  it("keeps closedAt and the assignee index true to the stored row", async () => {
    const stub = fresh()
    const issue = await ok<Issue>(stub, "issue.create", { title: "Race" })
    const owner: IssueActor = { kind: "person", id: "owner" }
    await withIssues(stub, (issues) =>
      Promise.all([
        issues.update(owner, issue.id, { state: "done", assignees: [{ kind: "person", id: "ann" }] }),
        issues.update(owner, issue.id, { state: "waiting", assignees: [{ kind: "person", id: "bob" }] }),
      ]),
    )
    const stored = (await ok<IssueDetail>(stub, "issue.get", { id: issue.id })).issue
    expect(stored.state).toBe("waiting")
    expect(stored.closedAt).toBeNull()
    const indexed = await runInDurableObject(stub, (home: Home) =>
      home.db.all<{ assignee: string }>("SELECT assignee FROM issue_assignees WHERE issue_id = ?", issue.id),
    )
    expect(indexed.map((entry) => entry.assignee)).toEqual(["person:bob"])
  })
})

describe("issue wake rules", () => {
  it("settles two agents mentioning each other after a few hops", async () => {
    const stub = fresh()
    const work = await project(stub, "loop")
    const [first, second] = await addThreads(stub, work.id, ["A", "B"])
    if (first === undefined || second === undefined) throw new Error("no threads")
    const issue = await withIssues(
      stub,
      async (issues) => (await issues.create(thread(first.id), { title: "Talk" })).issue,
    )
    await withIssues(stub, async (issues) => {
      for (let n = 0; n < 10; n += 1) {
        const [actor, other] = n % 2 === 0 ? [first.id, second.id] : [second.id, first.id]
        await issues.comment(thread(actor), issue.id, { body: `round ${n}`, mentions: [other] })
      }
    })
    expect(await jobs(stub)).toHaveLength(3)
    await ok(stub, "issue.comment", { id: issue.id, body: "owner steps in", mentions: [first.id] })
    expect(await jobs(stub)).toHaveLength(4)
  })

  it("counts every waking agent change as a hop, comments and updates alike, until a person acts", async () => {
    const stub = fresh()
    const work = await project(stub, "relay")
    const [first, second] = await addThreads(stub, work.id, ["A", "B"])
    if (first === undefined || second === undefined) throw new Error("no threads")
    const issue = await ok<Issue>(stub, "issue.create", { title: "Relay", threads: [first.id] })
    const states = ["in-progress", "in-review"]
    await withIssues(stub, async (issues) => {
      for (let n = 0; n < 10; n += 1) {
        await issues.comment(thread(first.id), issue.id, { body: `ask ${n}`, mentions: [second.id] })
        await issues.update(thread(second.id), issue.id, { state: states[n % 2] ?? "todo" })
      }
    })
    expect((await jobs(stub)).length).toBeLessThanOrEqual(3)
  })

  it("wakes initial assignees and folds several changes into one wake per target", async () => {
    const stub = fresh()
    const work = await project(stub, "fold")
    const coordinator = work.coordinatorId
    const created = await ok<Issue>(stub, "issue.create", {
      title: "Assigned at birth",
      assignees: [{ kind: "captain", id: coordinator }],
    })
    expect((await jobs(stub)).map((job) => job.target)).toEqual([coordinator])
    expect((await jobs(stub))[0]?.body).toContain("assigned you")

    const owned = await ok<Issue>(stub, "issue.create", { title: "Owned", threads: [coordinator] })
    await ok(stub, "issue.update", { id: owned.id, state: "in-progress", assignees: [{ kind: "person", id: "ann" }] })
    const woken = await jobs(stub)
    expect(woken).toHaveLength(2)
    expect(woken[1]?.body).toContain("moved it from Todo to In progress")
    expect(woken[1]?.body).toContain("set the assignees to person:ann")
    expect(created.id).toBeLessThan(owned.id)
  })

  it("records, publishes and wakes the moves a state deletion makes", async () => {
    const stub = fresh()
    const work = await project(stub, "states")
    const issue = await ok<Issue>(stub, "issue.create", {
      title: "Parked",
      state: "waiting",
      threads: [work.coordinatorId],
    })
    const rev = () =>
      runInDurableObject(stub, async (home: Home) => {
        const snapshot = await home.loader.ctx.wire.snapshot()
        return (snapshot["issues"] as { rev: number }).rev
      })
    const before = await rev()
    await ok(stub, "issue.state.delete", { id: "waiting", moveTo: "done" })
    expect(await rev()).toBeGreaterThan(before)
    const detail = await ok<IssueDetail>(stub, "issue.get", { id: issue.id })
    expect(detail.timeline.at(-1)?.data).toEqual({ field: "state", from: "waiting", to: "done" })
    expect((await jobs(stub)).map((job) => job.body).join("\n")).toContain("moved it from Waiting to Done")
  })

  it("does not deliver twice when a crash lands between the intake enqueue and the outbox delete", async () => {
    const stub = fresh()
    const work = await project(stub, "twice")
    await ok(stub, "issue.create", { title: "Once", assignees: [{ kind: "thread", id: work.coordinatorId }] })
    const delivered = await jobs(stub)
    expect(delivered).toHaveLength(1)
    const commandId = await runInDurableObject(stub, async (home: Home) => {
      const item = (await home.intake()).find((entry) => entry.kind === "job")
      if (item === undefined) throw new Error("no job")
      await home.db.run(
        "INSERT INTO issue_wakes (command_id, issue_id, target, title, status, text) VALUES (?, 1, ?, '#1 Once', 'todo', 'again')",
        item.commandId,
        work.coordinatorId,
      )
      return item.commandId
    })
    await evictDurableObject(stub)
    await call(stub, "issue.states")
    expect(await jobs(stub)).toEqual(delivered)
    const left = await runInDurableObject(stub, (home: Home) =>
      home.db.all("SELECT command_id FROM issue_wakes WHERE command_id = ?", commandId),
    )
    expect(left).toEqual([])
  })

  it("moves statesRev, and only statesRev, on every state edit", async () => {
    const stub = fresh()
    const revs = () =>
      runInDurableObject(stub, async (home: Home) => {
        const snapshot = await home.loader.ctx.wire.snapshot()
        return snapshot["issues"] as { rev: number; statesRev: number }
      })
    const start = await revs()
    const seen = [start.statesRev]
    await ok(stub, "issue.state.create", { name: "Triage" })
    seen.push((await revs()).statesRev)
    await ok(stub, "issue.state.update", { id: "triage", name: "Triage queue" })
    seen.push((await revs()).statesRev)
    await ok(stub, "issue.state.update", { id: "triage", position: 0 })
    seen.push((await revs()).statesRev)
    await ok(stub, "issue.state.update", { id: "triage", name: "Triage queue", position: 0 })
    seen.push((await revs()).statesRev)
    await ok(stub, "issue.state.delete", { id: "triage", moveTo: "todo" })
    const end = await revs()
    seen.push(end.statesRev)
    expect(seen).toEqual([0, 1, 2, 3, 3, 4])
    expect(end.rev).toBe(start.rev)
  })

  it("delivers a wake left in the outbox by a crash on the next boot", async () => {
    const stub = fresh()
    const work = await project(stub, "outbox")
    await runInDurableObject(stub, (home: Home) =>
      home.db.run(
        "INSERT INTO issue_wakes (command_id, issue_id, target, title, status, text) VALUES (?, ?, ?, ?, ?, ?)",
        "issue:99:crash",
        1,
        work.coordinatorId,
        "#1 Lost",
        "todo",
        "stranded wake",
      ),
    )
    await evictDurableObject(stub)
    await call(stub, "issue.states")
    expect((await jobs(stub)).map((job) => job.target)).toEqual([work.coordinatorId])
    const left = await runInDurableObject(stub, (home: Home) => home.db.all("SELECT command_id FROM issue_wakes"))
    expect(left).toEqual([])
  })
})

describe("issue reads stay bounded", () => {
  it("shows the newest timeline page and pages back to the oldest", async () => {
    const stub = fresh()
    const issue = await ok<Issue>(stub, "issue.create", { title: "Busy" })
    await withIssues(stub, async (issues) => {
      for (let n = 0; n < 120; n += 1)
        await issues.comment({ kind: "person", id: "owner" }, issue.id, { body: `comment ${n}` })
    })
    const latest = await ok<IssueDetail>(stub, "issue.get", { id: issue.id })
    expect(latest.timeline).toHaveLength(100)
    expect(latest.timeline.at(-1)?.data["body"]).toBe("comment 119")
    expect(latest.earlier).not.toBeNull()
    const older = await ok<IssueDetail>(stub, "issue.get", { id: issue.id, before: latest.earlier })
    expect(older.timeline.map((event) => event.kind)[0]).toBe("created")
    expect(older.timeline).toHaveLength(21)
    expect(older.earlier).toBeNull()
  })

  it("filters a search to the caller's project before ranking, and pages past the first hundred", async () => {
    const stub = fresh()
    const near = await project(stub, "near")
    const far = await project(stub, "far")
    await withIssues(stub, async (issues) => {
      for (let n = 0; n < 150; n += 1)
        await issues.create(thread(far.coordinatorId), { title: `needle far ${n}`, description: "needle needle" })
      await issues.create(thread(near.coordinatorId), { title: "needle near" })
    })
    const scoped = await withIssues(stub, (issues) => issues.list(thread(near.coordinatorId), { q: "needle" }))
    expect(scoped.issues.map((issue) => issue.title)).toEqual(["needle near"])
    const seen = new Set<number>()
    let cursor: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const result = await ok<IssuePage>(stub, "issue.list", {
        q: "needle",
        limit: 60,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const issue of result.issues) seen.add(issue.id)
      if (result.cursor === null) break
      cursor = result.cursor
    }
    expect(seen.size).toBe(151)
    const open = await ok<IssuePage>(stub, "issue.list", { q: "needle", states: ["todo"], project: near.id })
    expect(open.issues.map((issue) => issue.title)).toEqual(["needle near"])
  })

  it("matches a scoped search on the exact project, not a project id it prefixes", async () => {
    const stub = fresh()
    const near = await project(stub, "near")
    await storedRow(stub, "needle lookalike", `${near.id}-2`)
    await storedRow(stub, "needle lookalike spaced", `${near.id} 2`)
    await ok(stub, "issue.create", { title: "needle near", threads: [near.coordinatorId] })
    const scoped = await withIssues(stub, (issues) => issues.list(thread(near.coordinatorId), { q: "needle" }))
    expect(scoped.issues.map((issue) => issue.title)).toEqual(["needle near"])
    const owner = await ok<IssuePage>(stub, "issue.list", { q: "needle", project: near.id })
    expect(owner.issues.map((issue) => issue.title)).toEqual(["needle near"])
  })

  it("holds every write path to the op size limits", async () => {
    const stub = fresh()
    const work = await project(stub, "sizes")
    await withIssues(stub, async (issues) => {
      const agent = thread(work.coordinatorId)
      expect(await refusal(issues.create(agent, { title: "x", description: "d".repeat(20_001) }))).toContain(
        "20000 characters",
      )
      expect(await refusal(issues.create(agent, { title: "x", labels: ["l".repeat(41)] }))).toContain("40 characters")
      expect(await refusal(issues.create(agent, { title: "t".repeat(301) }))).toContain("300 characters")
      const { issue } = await issues.create(agent, { title: "ok" })
      expect(await refusal(issues.comment(agent, issue.id, { body: "b".repeat(20_001) }))).toContain("20000 characters")
    })
  })
})
