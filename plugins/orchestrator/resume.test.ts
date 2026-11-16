import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { ThreadDoc, type ThreadDocState } from "../../src/contracts/threaddoc.ts"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { resumableError } from "./threads.ts"

const context = BACKGROUND_CONTEXT
const NOTE = "A resume is scheduled in 30 s."
const WATCHDOG_KIND = "xin.watchdog"
/** pi retries a transient provider error inside the run first: six backoffs, about 122 s. */
const RETRIED_RUN_MS = 160_000

type Stub = ReturnType<typeof fresh>
type Report = { readonly commandId: string; readonly body: string }

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

async function settled(
  stub: Stub,
  threadId: number,
  run: number,
  status: string,
  reports: number,
  withinMs = 10_000,
): Promise<void> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline;) {
    const done = await runInDurableObject(stub, async (home: Home) => {
      const doc = await docIn(home, threadId)
      return doc?.run === run && doc.status === status && (await reportsIn(home, threadId)).length === reports
    })
    if (done) return
    await new Promise((resolve) => setTimeout(resolve, 100))
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

const failedWith = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage })

describe("automatic resume", () => {
  it("resumes only provider errors that are transient and not final", () => {
    for (const text of [
      "503 Service Unavailable",
      "provider overloaded",
      "429 Too Many Requests",
      "Provider returned an error: Unexpected end of JSON input",
    ])
      expect(resumableError(failedWith(text)), text).toBe(true)
    for (const text of [
      "402 Provider returned error: insufficient credits",
      "401 Unauthorized: upstream connect error",
      "400 invalid_request_error: request timed out",
      "Your credit balance is too low; servers are currently busy",
      "invalid api key",
    ])
      expect(resumableError(failedWith(text)), text).toBe(false)
  })

  it(
    "resumes a transient failure exactly once across an eviction, and never the resumed run's failure",
    async () => {
      const stub = fresh()
      const threadId = await start(stub, "broken", "broken job")
      await settled(stub, threadId, 1, "failed", 1, RETRIED_RUN_MS)
      const failed = await docOf(stub, threadId)
      expect(failed?.resume).toMatchObject({ run: 1, reason: "broken: provider overloaded" })
      expect(failed?.resume?.at).toBeGreaterThan(Date.now())
      expect((await reportsOf(stub, threadId))[0]?.body).toContain(NOTE)

      await evictDurableObject(stub)
      await fireResume(stub, threadId)
      await settled(stub, threadId, 2, "failed", 2, RETRIED_RUN_MS)
      const second = await docOf(stub, threadId)
      expect(second?.resumedRun).toBe(2)
      expect(second?.resume).toBeUndefined()
      const reports = await reportsOf(stub, threadId)
      expect(reports.find((row) => row.commandId === `report:${threadId}:2`)?.body).not.toContain(NOTE)

      await evictDurableObject(stub)
      await quiet(stub)
      expect((await docOf(stub, threadId))?.run).toBe(2)
      expect((await reportsOf(stub, threadId)).map((row) => row.commandId).toSorted()).toEqual([
        `report:${threadId}:1`,
        `report:${threadId}:2`,
      ])
    },
    2 * RETRIED_RUN_MS + 30_000,
  )

  it("does not resume a deterministic provider error", async () => {
    const stub = fresh()
    const threadId = await start(stub, "invalid", "invalid job")
    await settled(stub, threadId, 1, "failed", 1)
    expect((await docOf(stub, threadId))?.resume).toBeUndefined()
    expect((await reportsOf(stub, threadId))[0]?.body).not.toContain(NOTE)
  }, 30_000)

  it("never resumes an archived thread", async () => {
    const stub = fresh()
    const threadId = await start(stub, "archived", "invalid job")
    await settled(stub, threadId, 1, "failed", 1)
    const pending = { run: 1, at: Date.now() + 30_000, reason: "provider overloaded" }
    await edit(stub, threadId, (doc) => {
      doc.resume = pending
    })
    const archived = await cmd(stub, "archive-1", "thread.archive", { threadId })
    expect(archived.ok, JSON.stringify(archived)).toBe(true)
    expect((await docOf(stub, threadId))?.resume).toBeUndefined()

    await edit(stub, threadId, (doc) => {
      doc.resume = { ...pending, at: Date.now() - 1 }
    })
    await quiet(stub)
    const after = await docOf(stub, threadId)
    expect(after).toMatchObject({ run: 1, status: "failed", archived: true })
    expect(after?.resume).toBeUndefined()
  }, 30_000)

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
  }, 30_000)

  it("does not resume a stall, which a long healthy stream can look like", async () => {
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
    expect(doc?.resume).toBeUndefined()
    expect((await reportsOf(stub, threadId))[0]?.body).not.toContain(NOTE)
  }, 30_000)

  it("keeps a run's late settle from overwriting the run that reopened the thread", async () => {
    const stub = fresh()
    const threadId = await start(stub, "late", "quick job")
    await eventually(stub, async (home: Home) => {
      const live = await home.harness.snapshot(LiveDoc, threadId as ConversationId, context)
      return live?.tools?.some((slot) => slot.name === "quick_tool" && slot.status === "running") === true
    })
    await edit(stub, threadId, (doc) => {
      doc.status = "failed"
      doc.result = "failed: marked by the test"
    })
    const sent = await cmd(stub, "late-send", "thread.send", { threadId, text: "go on", mode: "queue" })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    expect((await docOf(stub, threadId))?.run).toBe(2)

    await settled(stub, threadId, 2, "completed", 1)
    await quiet(stub)
    expect((await reportsOf(stub, threadId)).map((row) => row.commandId)).toEqual([`report:${threadId}:2`])
  }, 30_000)
})
