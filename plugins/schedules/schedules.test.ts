import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { CommandId } from "../../src/ids.ts"
import { dueOf, type ScheduleInput, SCHEDULE_TASK, sendDue, slotKey } from "./schedules.ts"
import { eventually, field, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Row = {
  readonly kind: string
  readonly command_id: string
  readonly body: string
  readonly client_ts: number
  readonly target: number
  readonly status: string
}

const run = (home: Home, id: string, op: string, args: unknown = {}) =>
  home.commands.run({ id: id as CommandId, op, args }, { kind: "owner" })

const rows = (home: Home) =>
  home.db.all<Row>("SELECT kind, command_id, body, client_ts, target, status FROM inbound ORDER BY id")

const live = async (home: Home) =>
  (await home.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((task) => task.record.kind === SCHEDULE_TASK)

const ports = (home: Home) => ({ intake: home.loader.ctx.intake, arm: async () => home.arm(home.harness.wake()) })

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const hourly = (target: ConversationId): ScheduleInput => ({
  id: "hydrate",
  prompt: "hydrate",
  tz: "UTC",
  target,
  anchor: Date.parse("2026-01-01T00:00:00Z"),
  when: { kind: "rrule", rrule: "FREQ=HOURLY;BYMINUTE=0" },
})

describe("schedules", () => {
  it("fires a one-shot reminder once and completes its task", async () => {
    const stub = fresh()
    const at = await runInDurableObject(stub, async (home: Home) => {
      const slot = Date.now() + 400
      const outcome = await run(home, "s1-create", "schedule.create", {
        id: "reminder-1",
        at: slot,
        tz: "UTC",
        prompt: "take pills",
      })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
      return slot
    })
    await eventually(stub, async (home: Home) => (await live(home)).length === 1)
    await delay(at - Date.now() + 50)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await eventually(stub, async (home: Home) => (await rows(home)).length === 1)

    const stored = await runInDurableObject(stub, (home: Home) => rows(home))
    expect(stored[0]).toMatchObject({ kind: "job", command_id: slotKey("reminder-1", at), client_ts: at })
    expect(JSON.parse(stored[0]?.body ?? "{}")).toEqual({
      kind: "job",
      threadId: "reminder-1",
      title: "take pills",
      status: "scheduled",
      text: "take pills",
    })
    await eventually(stub, async (home: Home) => (await live(home)).length === 0)
  })

  it("replays the send step without a second row", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const input = hourly((await home.root()).id)
      const due = dueOf(input, input.anchor - 1, 0, input.anchor)
      const recomputed = dueOf(input, input.anchor - 1, 0, input.anchor + 3 * 3_600_000)
      if (due === undefined || recomputed === undefined) throw new Error("expected a due window")
      await sendDue(ports(home), input, due)
      await sendDue(ports(home), input, due)
      return { due, recomputed, stored: await rows(home) }
    })
    expect(evidence.due).toEqual({ count: 1, latest: Date.parse("2026-01-01T00:00:00Z"), index: 0 })
    expect(evidence.recomputed).toEqual({ count: 4, latest: Date.parse("2026-01-01T03:00:00Z"), index: 3 })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.stored[0]?.command_id).toBe(slotKey("hydrate", Date.parse("2026-01-01T00:00:00Z")))
  })

  it("collapses three missed slots into one fire", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const input = hourly((await home.root()).id)
      const due = dueOf(input, input.anchor - 1, 0, input.anchor + 3 * 3_600_000 - 1)
      if (due === undefined) throw new Error("expected a due window")
      await sendDue(ports(home), input, due)
      return { due, stored: await rows(home) }
    })
    expect(evidence.due).toEqual({
      count: 3,
      latest: Date.parse("2026-01-01T02:00:00Z"),
      index: 2,
    })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.stored[0]).toMatchObject({
      kind: "job",
      command_id: slotKey("hydrate", Date.parse("2026-01-01T02:00:00Z")),
    })
    expect(JSON.parse(evidence.stored[0]?.body ?? "{}")).toEqual({
      kind: "job",
      threadId: "hydrate",
      title: "hydrate",
      status: "scheduled",
      text: "hydrate (missed ×3)",
    })
  })

  it("creates one task when two creates race for the same id", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const at = Date.now() + 600_000
      const args = { id: "same-id", at, tz: "UTC", prompt: "ping" }
      const outcomes = await Promise.all([
        run(home, "race-a", "schedule.create", args),
        run(home, "race-b", "schedule.create", args),
      ])
      return { outcomes, tasks: (await live(home)).length }
    })
    expect(evidence.tasks).toBe(1)
    expect(evidence.outcomes.map((outcome) => outcome.kind)).toEqual(["ok", "ok"])
    const created = evidence.outcomes.map((outcome) => field(field(outcome, "result"), "created"))
    expect(created.filter((flag) => flag === true)).toHaveLength(1)
    expect(created.filter((flag) => flag === false)).toHaveLength(1)
  })

  it("targets a project's coordinator and rejects an unknown project", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const project = await run(home, "proj-create", "project.create", {
        slug: "writing",
        name: "Writing",
      })
      const at = Date.now() + 600_000
      const created = await run(home, "proj-schedule", "schedule.create", {
        id: "proj-slot",
        at,
        tz: "UTC",
        prompt: "draft",
        projectId: field(field(project, "result"), "id"),
      })
      const missing = await run(home, "proj-missing", "schedule.create", {
        id: "gone",
        at,
        tz: "UTC",
        prompt: "draft",
        projectId: "prj_nope",
      })
      const listed = await run(home, "proj-list", "schedule.list")
      return { coordinator: field(field(project, "result"), "coordinatorId"), created, missing, listed }
    })
    expect(evidence.created, JSON.stringify(evidence.created)).toMatchObject({ kind: "ok" })
    expect(evidence.missing).toMatchObject({ kind: "rejected", code: "bad_args", message: "no project prj_nope" })
    const schedules = field(field(evidence.listed, "result"), "schedules") as readonly { id: string; target: number }[]
    expect(schedules.find((schedule) => schedule.id === "proj-slot")?.target).toBe(evidence.coordinator)
  })

  it("cancel stops a pending schedule", async () => {
    const stub = fresh()
    const at = await runInDurableObject(stub, async (home: Home) => {
      const slot = Date.now() + 500
      await run(home, "s4-create", "schedule.create", { id: "doomed", at: slot, tz: "UTC", prompt: "ping" })
      return slot
    })
    await eventually(stub, async (home: Home) => (await live(home)).length === 1)

    const before = await runInDurableObject(stub, (home: Home) => run(home, "s4-list", "schedule.list"))
    expect(before, JSON.stringify(before)).toMatchObject({
      kind: "ok",
      result: { schedules: [{ id: "doomed", at, prompt: "ping" }] },
    })

    const cancelled = await runInDurableObject(stub, (home: Home) =>
      run(home, "s4-cancel", "schedule.cancel", { id: "doomed" }),
    )
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ kind: "ok", result: { cancelled: true } })
    await eventually(stub, async (home: Home) => (await live(home)).length === 0)

    await delay(at - Date.now() + 50)
    await runDurableObjectAlarm(stub)
    await delay(300)
    expect(await runInDurableObject(stub, (home: Home) => rows(home))).toHaveLength(0)
  })
})
