import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, type Stub, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { AutomationDetail, AutomationView } from "./automations.ts"
import { LegacySchedulesDoc } from "./legacy.ts"

const context = BACKGROUND_CONTEXT
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function op<T>(stub: Stub, name: string, args: unknown): Promise<T> {
  const ack = await cmd(stub, `${name}-${crypto.randomUUID()}`, name, args)
  expect(ack.ok, JSON.stringify(ack)).toBe(true)
  return ack.result as T
}

const detail = (stub: Stub, id: string): Promise<AutomationDetail> =>
  op<AutomationDetail>(stub, "automation.get", { id })

const listed = async (stub: Stub): Promise<AutomationView[]> =>
  (await op<{ automations: AutomationView[] }>(stub, "automation.list", {})).automations

function legacyRecords(root: number, coordinator: number, now: number): Record<string, unknown> {
  const record = (id: string, when: unknown, target: unknown, origin: number, last: number) => ({
    id,
    title: `Schedule ${id}`,
    prompt: `run ${id}`,
    tz: "Asia/Kolkata",
    anchor: now - 10 * DAY,
    when,
    target,
    origin,
    active: true,
    revision: 1,
    createdAt: now - 10 * DAY,
    updatedAt: new Date(now - 10 * DAY).toISOString(),
    cursor: { last, index: 0 },
  })
  const records = [
    record(
      "daily",
      { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=30" },
      { kind: "this_session", conversationId: root },
      root,
      now,
    ),
    record(
      "weekly",
      { kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0" },
      { kind: "new" },
      coordinator,
      now,
    ),
    record(
      "counted",
      { kind: "rrule", rrule: "FREQ=DAILY;COUNT=5;BYHOUR=8;BYMINUTE=0" },
      { kind: "this_session", conversationId: root },
      root,
      now,
    ),
    record("later", { kind: "at", at: now + HOUR }, { kind: "new_once" }, coordinator, now - 10 * DAY),
    record(
      "missed",
      { kind: "at", at: now - HOUR },
      { kind: "this_session", conversationId: root },
      root,
      now - 2 * HOUR,
    ),
    record(
      "midsend",
      { kind: "rrule", rrule: "FREQ=HOURLY;BYMINUTE=15" },
      { kind: "this_session", conversationId: root },
      root,
      now - 3 * HOUR,
    ),
  ]
  return Object.fromEntries(records.map((entry) => [entry.id, entry]))
}

async function seed(stub: Stub, records: Record<string, unknown>): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.harness.commit(async (tx) => {
      Object.assign((await tx.doc(LegacySchedulesDoc)).records, records)
    }, context),
  )
}

const legacyDoc = (stub: Stub) =>
  runInDurableObject(stub, (home: Home) => home.harness.snapshot(LegacySchedulesDoc, context))

describe("legacy schedule import", () => {
  it("converts xin.schedules records into automations once and retires the document", async () => {
    const stub = fresh()
    const project = await op<{ id: string; coordinatorId: number }>(stub, "project.create", {
      slug: "legacy",
      name: "legacy",
    })
    const root = await runInDurableObject(stub, async (home: Home) => Number((await home.root()).id))
    const now = Date.now()
    const records = legacyRecords(root, project.coordinatorId, now)
    await seed(stub, records)

    await evictDurableObject(stub)
    expect(await legacyDoc(stub)).toBeUndefined()

    const daily = await detail(stub, "sched-daily")
    expect(daily).toMatchObject({
      title: "Schedule daily",
      prompt: "run daily",
      target: "same",
      threadId: root,
      enabled: true,
      triggers: [{ kind: "schedule", cron: "30 7 * * *", tz: "Asia/Kolkata" }],
      runs: [],
    })

    expect(await detail(stub, "sched-weekly")).toMatchObject({
      target: "fresh",
      project: project.id,
      enabled: true,
      triggers: [{ kind: "schedule", cron: "0 9 * * 1,5", tz: "Asia/Kolkata" }],
    })

    const counted = await detail(stub, "sched-counted")
    expect(counted).toMatchObject({ enabled: false, triggers: [] })
    expect(counted.prompt).toContain("run counted")
    expect(counted.prompt).toContain("RRULE:FREQ=DAILY;COUNT=5;BYHOUR=8;BYMINUTE=0")

    expect(await detail(stub, "sched-later")).toMatchObject({
      target: "same",
      threadId: null,
      project: project.id,
      enabled: true,
      triggers: [{ kind: "once", at: new Date(now + HOUR).toISOString() }],
    })

    const missed = await detail(stub, "sched-missed")
    expect(missed).toMatchObject({ enabled: true, triggers: [] })
    expect(missed.runs.map((run) => run.id)).toEqual([`legacy:missed:${now - HOUR}`])

    const midsend = await detail(stub, "sched-midsend")
    expect(midsend.triggers).toMatchObject([{ kind: "schedule", cron: "15 * * * *" }])
    expect(midsend.runs).toHaveLength(1)
    expect(midsend.runs[0]?.id).toMatch(/^legacy:midsend:\d+$/)
    const slot = Number(midsend.runs[0]?.id.split(":")[2])
    expect(slot).toBeGreaterThan(now - 3 * HOUR)
    expect(slot).toBeLessThanOrEqual(now)
    expect(new Date(slot).getUTCMinutes()).toBe(45)

    const first = (await listed(stub)).map((automation) => automation.id).toSorted()
    expect(first).toEqual(
      Object.keys(records)
        .map((id) => `sched-${id}`)
        .toSorted(),
    )

    await seed(stub, records)
    await evictDurableObject(stub)
    expect(await legacyDoc(stub)).toBeUndefined()
    await evictDurableObject(stub)

    expect((await listed(stub)).map((automation) => automation.id).toSorted()).toEqual(first)
    expect((await detail(stub, "sched-daily")).triggers).toHaveLength(1)
    expect((await detail(stub, "sched-missed")).runs.map((run) => run.id)).toEqual([`legacy:missed:${now - HOUR}`])
    expect(await detail(stub, "sched-midsend")).toMatchObject({ runs: [{ id: midsend.runs[0]?.id }] })
  })
})
