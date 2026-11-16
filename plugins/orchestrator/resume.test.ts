import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { ThreadDoc, type ThreadDocState } from "../../src/contracts/threaddoc.ts"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const NOTE = "A resume is scheduled in 30 s."
const WATCHDOG_KIND = "xin.watchdog"

type Stub = ReturnType<typeof fresh>
type Report = { readonly commandId: string; readonly body: string }

/** Starts a thread on the faux model. pi retries a transient provider error inside the run first, about 14 s of backoff. */
async function start(stub: Stub, slug: string, task: string): Promise<number> {
  const project = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(project.ok, JSON.stringify(project)).toBe(true)
  const { coordinatorId } = project.result as { coordinatorId: number }
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    await conversation?.configure({ model: M6_MODEL }, context)
  })
  const created = await cmd(stub, `thread-${slug}`, "thread.create", { title: slug, task, project: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return (created.result as { threadId: number }).threadId
}

const docIn = (home: Home, threadId: number): Promise<ThreadDocState | undefined> =>
  home.harness.snapshot(ThreadDoc, threadId as ConversationId, context)

const docOf = (stub: Stub, threadId: number): Promise<ThreadDocState | undefined> =>
  runInDurableObject(stub, (home: Home) => docIn(home, threadId))

const reportsIn = async (home: Home, threadId: number): Promise<Report[]> =>
  (await home.intake())
    .filter((item) => item.kind === "report" && item.commandId.startsWith(`report:${threadId}:`))
    .map((item) => ({ commandId: item.commandId, body: item.body }))

const reportsOf = (stub: Stub, threadId: number): Promise<Report[]> =>
  runInDurableObject(stub, (home: Home) => reportsIn(home, threadId))

async function settled(stub: Stub, threadId: number, run: number, status: string, reports: number): Promise<void> {
  for (const deadline = Date.now() + 25_000; Date.now() < deadline;) {
    const done = await runInDurableObject(stub, async (home: Home) => {
      const doc = await docIn(home, threadId)
      return doc?.run === run && doc.status === status && (await reportsIn(home, threadId)).length === reports
    })
    if (done) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(
    `thread ${threadId} did not settle run ${run} as ${status}: ${JSON.stringify(await docOf(stub, threadId))}`,
  )
}

const stuck = (stub: Stub, threadId: number): Promise<void> =>
  eventually(stub, async (home: Home) => {
    const live = await home.harness.snapshot(LiveDoc, threadId as ConversationId, context)
    return live?.tools?.some((slot) => slot.name === "stuck_tool" && slot.status === "running") === true
  })

const edit = (stub: Stub, threadId: number, change: (doc: ThreadDocState) => void): Promise<void> =>
  runInDurableObject(stub, (home: Home) =>
    home.harness.commit(async (tx) => change(await tx.doc(ThreadDoc, threadId as ConversationId)), context),
  )

/** Moves a scheduled resume into the past and runs the alarm, as the clock would 30 s later. */
async function fireResume(stub: Stub, threadId: number): Promise<void> {
  await edit(stub, threadId, (doc) => {
    if (doc.resume !== undefined) doc.resume.at = Date.now() - 1
  })
  await runDurableObjectAlarm(stub)
}

/** The watchdog sleeps 30 s between checks; a fresh one checks at once. */
async function sweepNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    for (const task of (await home.harness.inspect(context)).tasks)
      if (task.record.kind === WATCHDOG_KIND) await home.harness.abortTask(task.record.id, context)
  })
  await eventually(stub, async (home: Home) =>
    (await home.harness.inspect(context)).tasks.every((task) => task.record.kind !== WATCHDOG_KIND),
  )
  await runDurableObjectAlarm(stub)
}

async function quiet(stub: Stub): Promise<void> {
  await runDurableObjectAlarm(stub)
  await new Promise((resolve) => setTimeout(resolve, 200))
}

describe("automatic resume", () => {
  it("resumes a transient provider failure once and leaves the resumed run's failure alone", async () => {
    const stub = fresh()
    const threadId = await start(stub, "broken", "broken job")
    await settled(stub, threadId, 1, "failed", 1)
    const failed = await docOf(stub, threadId)
    expect(failed?.resume).toMatchObject({ run: 1, reason: "broken: provider overloaded" })
    expect(failed?.resume?.at).toBeGreaterThan(Date.now())
    expect((await reportsOf(stub, threadId))[0]?.body).toContain(NOTE)

    await fireResume(stub, threadId)
    await settled(stub, threadId, 2, "failed", 2)
    const second = await docOf(stub, threadId)
    expect(second?.resumedRun).toBe(2)
    expect(second?.resume).toBeUndefined()
    const reports = await reportsOf(stub, threadId)
    expect(reports.find((row) => row.commandId === `report:${threadId}:2`)?.body).not.toContain(NOTE)

    await quiet(stub)
    expect((await docOf(stub, threadId))?.run).toBe(2)
  }, 60_000)

  it("resumes exactly once across an eviction between the failure and the resume", async () => {
    const stub = fresh()
    const threadId = await start(stub, "flaky", "flaky job")
    await settled(stub, threadId, 1, "failed", 1)
    expect((await docOf(stub, threadId))?.resume?.run).toBe(1)

    await evictDurableObject(stub)
    await fireResume(stub, threadId)
    await settled(stub, threadId, 2, "completed", 2)
    expect((await docOf(stub, threadId))?.result).toBe(
      "thread answer: Resume: the last run failed with provider overloaded. Continue where you stopped.",
    )

    await evictDurableObject(stub)
    await quiet(stub)
    const after = await docOf(stub, threadId)
    expect(after?.run).toBe(2)
    expect(after?.status).toBe("completed")
    expect((await reportsOf(stub, threadId)).map((row) => row.commandId).toSorted()).toEqual([
      `report:${threadId}:1`,
      `report:${threadId}:2`,
    ])
  }, 60_000)

  it("does not resume a deterministic provider error", async () => {
    const stub = fresh()
    const threadId = await start(stub, "invalid", "invalid job")
    await settled(stub, threadId, 1, "failed", 1)
    expect((await docOf(stub, threadId))?.resume).toBeUndefined()
    expect((await reportsOf(stub, threadId))[0]?.body).not.toContain(NOTE)
  }, 60_000)

  it("does not resume an overtime failure", async () => {
    const stub = fresh()
    const threadId = await start(stub, "overtime", "stuck job")
    await stuck(stub, threadId)
    await edit(stub, threadId, (doc) => {
      doc.beatAt = Date.now()
      doc.deadlineAt = Date.now() - 1
    })
    await sweepNow(stub)
    await settled(stub, threadId, 1, "failed", 1)
    const doc = await docOf(stub, threadId)
    expect(doc?.result).toBe("stopped: deadline exceeded")
    expect(doc?.resume).toBeUndefined()
    expect((await reportsOf(stub, threadId))[0]?.body).not.toContain(NOTE)
  }, 60_000)

  it("schedules a resume for a stalled thread", async () => {
    const stub = fresh()
    const threadId = await start(stub, "stall", "stuck job")
    await stuck(stub, threadId)
    await edit(stub, threadId, (doc) => {
      doc.beatAt = Date.now() - 125_000
    })
    await sweepNow(stub)
    await settled(stub, threadId, 1, "failed", 1)
    const doc = await docOf(stub, threadId)
    expect(doc?.result).toBe("stopped: no progress for 2 min in stuck_tool")
    expect(doc?.resume).toMatchObject({ run: 1, reason: "no progress for 2 min in stuck_tool" })
    expect((await reportsOf(stub, threadId))[0]?.body).toContain(NOTE)
  }, 60_000)
})
