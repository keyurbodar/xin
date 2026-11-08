import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type ConversationId, defineTask } from "@earendil-works/pi-durable"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Notification } from "../../src/contracts/push.ts"
import type { CommandId } from "../../src/ids.ts"
import { eventually, field, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { dueOf, SCHEDULE_TASK, type SchedulesPort, sendDue, slotKey, type StoredSchedule } from "./schedules.ts"

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

const timers = async (home: Home) =>
  (await home.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((task) => task.record.kind === SCHEDULE_TASK)

const ports = (home: Home): SchedulesPort => ({
  harness: home.harness,
  intake: home.loader.ctx.intake,
  notify: home.loader.ctx.push,
  arm: async () => home.arm(home.harness.wake()),
})

const recordingPorts = (home: Home, sent: Notification[]): SchedulesPort => ({
  ...ports(home),
  notify: {
    prefs: () => home.loader.ctx.push.prefs(),
    notify: async (notification) => {
      sent.push(notification)
    },
  },
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const ANCHOR = Date.parse("2026-01-01T00:00:00Z")
const HOUR = 3_600_000

const record = (target: StoredSchedule["target"], overrides: Partial<StoredSchedule> = {}): StoredSchedule => ({
  id: "hydrate",
  title: "hydrate",
  prompt: "hydrate",
  tz: "UTC",
  anchor: ANCHOR,
  when: { kind: "rrule", rrule: "FREQ=HOURLY;BYMINUTE=0" },
  target,
  origin: 1,
  active: true,
  revision: 1,
  createdAt: ANCHOR,
  updatedAt: new Date(ANCHOR).toISOString(),
  cursor: { last: ANCHOR - 1, index: 0 },
  ...overrides,
})

const legacyTimer = defineTask<
  { readonly id: string; readonly revision: number },
  { readonly phase: "wait" },
  null,
  object
>({
  name: SCHEDULE_TASK,
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: { wait: async () => undefined },
  abort: async () => undefined,
})

describe("schedules", () => {
  it("fires a one-shot reminder once and completes its task", async () => {
    const stub = fresh()
    const at = await runInDurableObject(stub, async (home: Home) => {
      const slot = Date.now() + 400
      const outcome = await run(home, "s1-create", "schedule.create", {
        id: "reminder-1",
        title: "Pills",
        at: slot,
        tz: "UTC",
        prompt: "take pills",
      })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
      return slot
    })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 1)
    await delay(at - Date.now() + 50)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await eventually(stub, async (home: Home) => (await rows(home)).length === 1)

    const stored = await runInDurableObject(stub, (home: Home) => rows(home))
    expect(stored[0]).toMatchObject({ kind: "job", command_id: slotKey("reminder-1", at), client_ts: at })
    expect(JSON.parse(stored[0]?.body ?? "{}")).toEqual({
      kind: "job",
      threadId: "reminder-1",
      title: "Pills",
      status: "scheduled",
      text: "take pills",
    })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 0)
  })

  it("parses plain words and answers the next three runs", async () => {
    const outcome = await runInDurableObject(fresh(), (home: Home) =>
      run(home, "p1-parse", "schedule.parse", { text: "every friday at 4pm", tz: "UTC" }),
    )
    expect(outcome).toMatchObject({
      kind: "ok",
      result: { rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0", tz: "UTC" },
    })
    const result = field(outcome, "result")
    const next = field(result, "next")
    expect(Array.isArray(next) ? next.length : 0).toBe(3)
    const unclear = await runInDurableObject(fresh(), (home: Home) =>
      run(home, "p1-parse-bad", "schedule.parse", { text: "whenever", tz: "UTC" }),
    )
    expect(unclear).toMatchObject({ kind: "rejected", code: "bad_args" })
  })

  it("keeps six runs and resolves each run's outcome only when asked", async () => {
    const stub = fresh()
    const at = await runInDurableObject(stub, async (home: Home) => {
      const slot = Date.now() + 400
      const outcome = await run(home, "r1-create", "schedule.create", {
        id: "runs-1",
        title: "Runs",
        at: slot,
        tz: "UTC",
        prompt: "check",
      })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
      return slot
    })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 1)
    await delay(at - Date.now() + 50)
    await runDurableObjectAlarm(stub)
    await eventually(stub, async (home: Home) => (await rows(home)).length === 1)

    const plain = await runInDurableObject(stub, (home: Home) => run(home, "r1-list", "schedule.list", {}))
    expect(plain).toMatchObject({ kind: "ok" })
    expect(JSON.stringify(plain)).not.toContain('"runs"')
    const running = await runInDurableObject(stub, (home: Home) =>
      run(home, "r1-list-1", "schedule.list", { outcomes: true }),
    )
    expect(running).toMatchObject({ kind: "ok", result: { schedules: [{ runs: [{ outcome: "running" }] }] } })

    await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.root()
      await conversation.submit(
        { type: "write", requestId: `run-ok-${crypto.randomUUID()}`, entry: { kind: "pi.assistant" } },
        BACKGROUND_CONTEXT,
      )
    })
    const done = await runInDurableObject(stub, (home: Home) =>
      run(home, "r1-list-2", "schedule.list", { outcomes: true }),
    )
    expect(done).toMatchObject({ result: { schedules: [{ runs: [{ outcome: "done" }] }] } })

    await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.root()
      await conversation.submit(
        {
          type: "write",
          requestId: `run-bad-${crypto.randomUUID()}`,
          entry: { kind: "xin.error", data: { taskId: 1, reason: "model_error", error: "boom" } },
        },
        BACKGROUND_CONTEXT,
      )
    })
    const failed = await runInDurableObject(stub, (home: Home) =>
      run(home, "r1-list-3", "schedule.list", { outcomes: true }),
    )
    expect(failed).toMatchObject({ result: { schedules: [{ runs: [{ outcome: "failed" }] }] } })
  })

  it("keeps at most six runs on a record", async () => {
    const kept = await runInDurableObject(fresh(), async (home: Home) => {
      let current = record({ kind: "this_session", conversationId: (await home.root()).id })
      for (let index = 0; index < 7; index += 1) {
        const due = dueOf(current, ANCHOR + index * HOUR + 1)
        if (due === undefined) throw new Error("expected a due window")
        current = await sendDue(ports(home), current, due, ANCHOR + index * HOUR)
      }
      return current.runs?.length
    })
    expect(kept).toBe(6)
  })

  it("replays the send step without a second row", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const delivered = record({ kind: "this_session", conversationId: (await home.root()).id })
      const due = dueOf(delivered, ANCHOR + 1)
      const recomputed = dueOf(delivered, ANCHOR + 3 * HOUR)
      if (due === undefined || recomputed === undefined) throw new Error("expected a due window")
      await sendDue(ports(home), delivered, due, ANCHOR)
      await sendDue(ports(home), delivered, due, ANCHOR)
      return { due, recomputed, stored: await rows(home) }
    })
    expect(evidence.due).toEqual({ count: 1, latest: ANCHOR, index: 0 })
    expect(evidence.recomputed).toEqual({ count: 4, latest: ANCHOR + 3 * HOUR, index: 3 })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.stored[0]?.command_id).toBe(slotKey("hydrate", ANCHOR))
  })

  it("collapses three missed slots into one fire", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const delivered = record({ kind: "this_session", conversationId: (await home.root()).id })
      const due = dueOf(delivered, ANCHOR + 3 * HOUR - 1)
      if (due === undefined) throw new Error("expected a due window")
      const next = await sendDue(ports(home), delivered, due, ANCHOR)
      return { due, next, stored: await rows(home) }
    })
    expect(evidence.due).toEqual({ count: 3, latest: ANCHOR + 2 * HOUR, index: 2 })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.stored[0]).toMatchObject({ kind: "job", command_id: slotKey("hydrate", ANCHOR + 2 * HOUR) })
    expect(JSON.parse(evidence.stored[0]?.body ?? "{}")).toEqual({
      kind: "job",
      threadId: "hydrate",
      title: "hydrate",
      status: "scheduled",
      text: "hydrate (missed ×3)",
    })
    expect(evidence.next.cursor).toEqual({ last: ANCHOR + 2 * HOUR, index: 3 })
  })

  it("creates one task when two creates race for the same id", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const at = Date.now() + 600_000
      const args = { id: "same-id", title: "Ping", at, tz: "UTC", prompt: "ping" }
      await home.root()
      const outcomes = await Promise.all([
        run(home, "race-a", "schedule.create", args),
        run(home, "race-b", "schedule.create", args),
      ])
      return { outcomes, tasks: (await timers(home)).length }
    })
    expect(evidence.tasks).toBe(1)
    expect(
      evidence.outcomes.map((outcome) => outcome.kind),
      JSON.stringify(evidence.outcomes),
    ).toEqual(["ok", "ok"])
    const created = evidence.outcomes.map((outcome) => field(field(outcome, "result"), "created"))
    expect(created.filter((flag) => flag === true)).toHaveLength(1)
    expect(created.filter((flag) => flag === false)).toHaveLength(1)
  })

  it("creates the same id twice in sequence and answers the stored task both times", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const at = Date.now() + 600_000
      const args = { id: "twice", title: "Ping", at, tz: "UTC", prompt: "ping" }
      await home.root()
      const first = await run(home, "twice-a", "schedule.create", args)
      const second = await run(home, "twice-b", "schedule.create", args)
      return { outcomes: [first, second], tasks: (await timers(home)).length }
    })
    expect(evidence.tasks).toBe(1)
    expect(
      evidence.outcomes.map((outcome) => [outcome.kind, field(field(outcome, "result"), "created")]),
      JSON.stringify(evidence.outcomes),
    ).toEqual([
      ["ok", true],
      ["ok", false],
    ])
    expect(
      evidence.outcomes.map((outcome) => field(field(field(outcome, "result"), "task"), "id")),
      JSON.stringify(evidence.outcomes),
    ).toEqual(["twice", "twice"])
  })

  it("delivers to the conversation that created the task", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const origin = (await home.root()).id
      const delivered = record({ kind: "this_session", conversationId: origin })
      const due = dueOf(delivered, ANCHOR + 1)
      if (due === undefined) throw new Error("expected a due window")
      await sendDue(ports(home), delivered, due, ANCHOR)
      return { origin, stored: await rows(home) }
    })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.stored[0]?.target).toBe(evidence.origin)
  })

  it("opens one conversation at the first delivery of a new_once task and reuses it", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const origin = (await home.root()).id
      const first = record({ kind: "new_once" })
      const due = dueOf(first, ANCHOR + 1)
      if (due === undefined) throw new Error("expected a due window")
      const after = await sendDue(ports(home), first, due, ANCHOR)
      const second = dueOf(after, ANCHOR + HOUR + 1)
      if (second === undefined) throw new Error("expected a second due window")
      await sendDue(ports(home), after, second, ANCHOR + HOUR)
      const opened = after.target.kind === "new_once" ? after.target.conversationId : undefined
      return {
        origin,
        opened,
        exists:
          opened === undefined
            ? false
            : (await home.harness.conversation(opened as ConversationId, BACKGROUND_CONTEXT)) !== undefined,
        stored: await rows(home),
      }
    })
    expect(evidence.opened).toBeDefined()
    expect(evidence.opened).not.toBe(evidence.origin)
    expect(evidence.exists).toBe(true)
    expect(evidence.stored).toHaveLength(2)
    expect(evidence.stored.map((row) => row.target)).toEqual([evidence.opened, evidence.opened])
  })

  it("opens a different conversation for every delivery of a new task", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const delivered = record({ kind: "new" })
      const due = dueOf(delivered, ANCHOR + 1)
      if (due === undefined) throw new Error("expected a due window")
      await sendDue(ports(home), delivered, due, ANCHOR)
      const second = dueOf({ ...delivered, cursor: { last: ANCHOR, index: 1 } }, ANCHOR + HOUR + 1)
      if (second === undefined) throw new Error("expected a second due window")
      await sendDue(ports(home), delivered, second, ANCHOR + HOUR)
      return { stored: await rows(home) }
    })
    expect(evidence.stored).toHaveLength(2)
    const targets = evidence.stored.map((row) => row.target)
    expect(targets[0]).not.toBe(targets[1])
  })

  it("keeps an edit after an eviction", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      const at = Date.now() + 600_000
      const created = await run(home, "e1-create", "schedule.create", {
        id: "edited",
        title: "Hydrate",
        at,
        tz: "UTC",
        prompt: "drink water",
      })
      expect(created, JSON.stringify(created)).toMatchObject({ kind: "ok" })
      const edited = await run(home, "e1-edit", "schedule.edit", {
        id: "edited",
        action: "update",
        prompt: "drink more water",
      })
      expect(edited, JSON.stringify(edited)).toMatchObject({ kind: "ok", result: { prompt: "drink more water" } })
    })
    await evictDurableObject(stub)
    const viewed = await runInDurableObject(stub, (home: Home) =>
      run(home, "e1-view", "schedule.view", { id: "edited" }),
    )
    expect(viewed, JSON.stringify(viewed)).toMatchObject({
      kind: "ok",
      result: { id: "edited", title: "Hydrate", prompt: "drink more water", active: true },
    })
  })

  it("refuses to resume a rule with no future occurrence", async () => {
    const stub = fresh()
    const at = await runInDurableObject(stub, async (home: Home) => {
      const slot = Date.now() + 400
      await run(home, "x1-create", "schedule.create", {
        id: "spent",
        title: "Once",
        at: slot,
        tz: "UTC",
        prompt: "once",
      })
      return slot
    })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 1)
    await delay(at - Date.now() + 50)
    await runDurableObjectAlarm(stub)
    await eventually(stub, async (home: Home) => (await rows(home)).length === 1)
    await eventually(stub, async (home: Home) => {
      const viewed = await run(home, `x1-view-${crypto.randomUUID()}`, "schedule.view", { id: "spent" })
      return field(field(viewed, "result"), "nextAt") === null
    })
    const resumed = await runInDurableObject(stub, (home: Home) =>
      run(home, "x1-resume", "schedule.edit", { id: "spent", action: "update", active: true }),
    )
    expect(resumed).toMatchObject({
      kind: "rejected",
      code: "bad_args",
      message: "This task has no future occurrence. Set a new rrule before resuming it.",
    })
  })

  it("cancel stops a pending schedule and answers not found afterwards", async () => {
    const stub = fresh()
    const at = await runInDurableObject(stub, async (home: Home) => {
      const slot = Date.now() + 500
      await run(home, "c1-create", "schedule.create", {
        id: "doomed",
        title: "Ping",
        at: slot,
        tz: "UTC",
        prompt: "ping",
      })
      return slot
    })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 1)

    const before = await runInDurableObject(stub, (home: Home) => run(home, "c1-list", "schedule.list"))
    expect(before, JSON.stringify(before)).toMatchObject({
      kind: "ok",
      result: { schedules: [{ id: "doomed", title: "Ping", prompt: "ping", at: new Date(at).toISOString() }] },
    })

    const cancelled = await runInDurableObject(stub, (home: Home) =>
      run(home, "c1-cancel", "schedule.cancel", { id: "doomed" }),
    )
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ kind: "ok", result: { cancelled: true } })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 0)

    await delay(at - Date.now() + 50)
    await runDurableObjectAlarm(stub)
    await delay(300)
    expect(await runInDurableObject(stub, (home: Home) => rows(home))).toHaveLength(0)
    const viewed = await runInDurableObject(stub, (home: Home) =>
      run(home, "c1-view", "schedule.view", { id: "doomed" }),
    )
    expect(viewed).toMatchObject({ kind: "ok", result: { id: "doomed", code: "schedule_not_found" } })
  })

  it("retires a version 1 timer instead of running it beside the new record", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      const origin = (await home.root()).id
      const created = await run(home, "legacy-create", "schedule.create", {
        id: "shared",
        title: "Shared",
        at: Date.now() + 600_000,
        tz: "UTC",
        prompt: "ping",
      })
      expect(created, JSON.stringify(created)).toMatchObject({ kind: "ok" })
      await home.harness.commit(async (tx) => {
        await tx.createTask(
          legacyTimer,
          { id: "shared", revision: 1 },
          { ownership: { kind: "conversation" }, conversationId: origin, background: true },
        )
      }, BACKGROUND_CONTEXT)
    })
    await eventually(stub, async (home: Home) => (await timers(home)).length === 1)
    const tasks = await runInDurableObject(stub, (home: Home) => timers(home))
    expect(tasks.map((task) => task.record.version)).toEqual([2])
  })

  it("sends one notification for a due schedule once schedule prefs are on", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const defaults = await run(home, "n1-defaults", "notify.prefs")
      const enabled = await run(home, "n1-enable", "notify.set", { schedule: true })
      const read = await run(home, "n1-read", "notify.prefs")
      const delivered = record(
        { kind: "this_session", conversationId: (await home.root()).id },
        { prompt: "p".repeat(130) },
      )
      const due = dueOf(delivered, ANCHOR + 1)
      if (due === undefined) throw new Error("expected a due window")
      const sent: Notification[] = []
      await sendDue(recordingPorts(home, sent), delivered, due, ANCHOR)
      return {
        defaults: field(defaults, "result"),
        enabled: field(enabled, "result"),
        read: field(read, "result"),
        sent,
        stored: await rows(home),
      }
    })
    expect(evidence.defaults).toMatchObject({ schedule: false })
    expect(evidence.enabled).toMatchObject({ schedule: true, waiting: true })
    expect(evidence.read).toMatchObject({ schedule: true })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.sent).toEqual([
      {
        threadTitle: "hydrate",
        title: "A schedule ran",
        body: "p".repeat(120),
        tag: `schedule:hydrate:${ANCHOR}`,
        kind: "schedule",
      },
    ])
  })

  it("sends no notification for a due schedule while schedule prefs are off", async () => {
    const evidence = await runInDurableObject(fresh(), async (home: Home) => {
      const delivered = record({ kind: "this_session", conversationId: (await home.root()).id })
      const due = dueOf(delivered, ANCHOR + 1)
      if (due === undefined) throw new Error("expected a due window")
      const sent: Notification[] = []
      await sendDue(recordingPorts(home, sent), delivered, due, ANCHOR)
      return { sent, stored: await rows(home) }
    })
    expect(evidence.stored).toHaveLength(1)
    expect(evidence.sent).toEqual([])
  })
})
