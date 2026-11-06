import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M6_MODEL } from "../test/plugins/m6.ts"
import { eventually, fresh } from "../test/support.ts"
import type { Home } from "../test/worker.ts"
import { STALL_MS, WATCHDOG_KIND } from "./watchdog.ts"
import { ThreadDoc } from "./threaddoc.ts"
import { WorkspaceDoc } from "./workspace.ts"
import { JobsDoc } from "./jobs.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}
type ThreadRow = { readonly id: number; readonly title: string; readonly status: string }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number }
}

async function chooseModel(stub: Stub, coordinatorId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M6_MODEL }, context)
  })
}

async function send(stub: Stub, id: string, coordinatorId: number, text: string): Promise<void> {
  const outcome = await cmd(stub, id, "message.send", { conv: coordinatorId, text })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
}

const threads = async (home: Home, projectId: string): Promise<ThreadRow[]> => {
  const workspace = await home.harness.snapshot(WorkspaceDoc, context)
  const ids = workspace?.projects[projectId]?.threadIds ?? []
  const found: ThreadRow[] = []
  for (const id of ids) {
    const doc = await home.harness.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc !== undefined) found.push({ id, title: doc.title, status: doc.status })
  }
  return found
}

const threadOf = async (home: Home, projectId: string): Promise<ThreadRow | undefined> => {
  const found = await threads(home, projectId)
  return found[0]
}

type ReportRow = { command_id: string; status: string; body: string }

const reports = (home: Home): Promise<ReportRow[]> =>
  home.db.all<ReportRow>("SELECT command_id, status, body FROM inbound WHERE kind = 'report' ORDER BY id")

function statusOf(body: string): string {
  const value: unknown = JSON.parse(body)
  if (typeof value !== "object" || value === null) return ""
  const status = Reflect.get(value, "status")
  return typeof status === "string" ? status : ""
}

async function restartWatchdog(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const inspection = await home.harness.inspect(context)
    for (const task of inspection.tasks) {
      if (task.record.kind === WATCHDOG_KIND) await home.harness.abortTask(task.record.id, context)
    }
  })
  await eventually(stub, async (home: Home) =>
    (await home.harness.inspect(context)).tasks.every((task) => task.record.kind !== WATCHDOG_KIND),
  )
  await runDurableObjectAlarm(stub)
}

describe("watchdog", () => {
  it("fails a thread that makes no progress and reports it once", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "hung")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "hung-1", project.coordinatorId, "delegate stuck")
    await fireNow(stub)

    await eventually(stub, async (home: Home) => {
      const thread = await threadOf(home, project.id)
      if (thread?.status !== "working") return false
      const live = await home.harness.snapshot(LiveDoc, thread.id as ConversationId, context)
      return live?.tools?.some((slot) => slot.name === "stuck_tool" && slot.status === "running") === true
    })
    const thread = await runInDurableObject(stub, (home: Home) => threadOf(home, project.id))
    if (thread === undefined) throw new Error("no thread")

    await runInDurableObject(stub, async (home: Home) => {
      await home.harness.commit(async (tx) => {
        const doc = await tx.doc(ThreadDoc, thread.id as ConversationId)
        doc.beatAt = Date.now() - STALL_MS - 1_000
      }, context)
    })
    await restartWatchdog(stub)

    await eventually(stub, async (home: Home) =>
      (await reports(home)).some((row) => row.command_id === `report:${thread.id}:1`),
    )
    const found = await runInDurableObject(stub, async (home: Home) => {
      const all = await reports(home)
      return {
        row: all.find((report) => report.command_id === `report:${thread.id}:1`),
        count: all.filter((report) => report.command_id === `report:${thread.id}:1`).length,
        doc: await home.harness.snapshot(ThreadDoc, thread.id as ConversationId, context),
      }
    })
    expect(statusOf(found.row?.body ?? "")).toBe("failed")
    expect(found.row?.body).toContain("stopped: no progress for 2 min in stuck_tool")
    expect(found.count).toBe(1)
    expect(found.doc?.status).toBe("failed")
    expect(found.doc?.result).toBe("stopped: no progress for 2 min in stuck_tool")

    await runDurableObjectAlarm(stub)
    const again = await runInDurableObject(stub, async (home: Home) => {
      const rows = await reports(home)
      return rows.filter((report) => report.command_id === `report:${thread.id}:1`).length
    })
    expect(again).toBe(1)
  }, 30_000)

  it("leaves a three-minute job alone until its deadline", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "job-alive")
    const now = Date.now()
    await runInDurableObject(stub, async (home: Home) => {
      await home.harness.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc)
        doc.jobs["424242"] = {
          tool: "slow_tool",
          title: "slow_tool",
          startedAt: now - 3 * 60_000,
          deadlineAt: now + 60_000,
          parentId: project.coordinatorId,
        }
      }, context)
    })

    await restartWatchdog(stub)
    await eventually(stub, async (home: Home) =>
      (await home.harness.inspect(context)).tasks.some((task) => task.record.kind === WATCHDOG_KIND),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const found = await runInDurableObject(stub, async (home: Home) => ({
      jobs: Object.keys((await home.harness.snapshot(JobsDoc, context))?.jobs ?? {}),
      reports: await reports(home),
    }))
    expect(found.jobs).toEqual(["424242"])
    expect(found.reports).toEqual([])
  }, 20_000)

  it("finishes when only a waiting thread is left", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "waiting-only")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "waiting-only-1", project.coordinatorId, "delegate ask")
    await fireNow(stub)
    await eventually(stub, async (home: Home) => (await threadOf(home, project.id))?.status === "waiting")

    await restartWatchdog(stub)
    await eventually(stub, async (home: Home) => {
      const inspection = await home.harness.inspect(context)
      return inspection.tasks.every((task) => task.record.kind !== WATCHDOG_KIND)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const after = await runInDurableObject(stub, async (home: Home) => ({
      live: (await home.harness.inspect(context)).tasks.filter((task) => task.record.kind === WATCHDOG_KIND).length,
      thread: await threadOf(home, project.id),
    }))
    expect(after.live).toBe(0)
    expect(after.thread?.status).toBe("waiting")
  }, 20_000)
})
