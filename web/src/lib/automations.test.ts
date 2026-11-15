import { expect, test } from "bun:test"
import {
  automationsRevisionOf,
  createArgs,
  cronInWords,
  describeTriggers,
  draftReady,
  nextLabel,
  parseAutomationList,
  runSignal,
  triggerSummary,
} from "./automations.ts"

const wire = {
  id: "a1",
  title: "Nightly gate",
  prompt: "Run the gate",
  project: "prj_1",
  target: "same",
  threadId: 7,
  enabled: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  nextAt: "2026-11-17T02:00:00.000Z",
  triggers: [
    { id: "t1", kind: "schedule", cron: "0 2 * * *", tz: "Asia/Kolkata", nextAt: "2026-11-17T02:00:00.000Z" },
    { id: "t2", kind: "webhook", path: "/hooks/abc", contains: [], regex: null, rules: [] },
    { id: "t3", kind: "mystery" },
  ],
  lastRun: { id: "r1", automationId: "a1", status: "failed", threadId: null, createdAt: "2026-11-16T02:00:00.000Z", error: "boom" },
}

test("the list parses every automation and drops triggers and rows it cannot read", () => {
  const list = parseAutomationList({ automations: [wire, { id: "no-title" }, "junk"] })
  expect(list).toHaveLength(1)
  expect(list[0]?.target).toBe("same")
  expect(list[0]?.triggers.map((trigger) => trigger.kind)).toEqual(["schedule", "webhook"])
  expect(list[0]?.lastRun).toEqual({ id: "r1", status: "failed", threadId: null, createdAt: "2026-11-16T02:00:00.000Z", error: "boom" })
})

test("a last run with an unknown status is no last run", () => {
  expect(parseAutomationList({ automations: [{ ...wire, lastRun: { ...wire.lastRun, status: "exploded" } }] })[0]?.lastRun).toBeNull()
})

test("the revision comes from the home snapshot's automations part", () => {
  expect(automationsRevisionOf({ projects: [], automations: { revision: 4 } })).toBe(4)
  expect(automationsRevisionOf({ projects: [] })).toBeUndefined()
})

test.each([
  ["* * * * *", "Every minute"],
  ["*/15 * * * *", "Every 15 minutes"],
  ["5 * * * *", "Every hour at :05"],
  ["30 */6 * * *", "Every 6 hours at :30"],
  ["0 2 * * *", "Every day at 02:00"],
  ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
  ["0 9 * * 1-5", "Weekdays at 09:00"],
  ["0 10 * * 0,6", "Weekends at 10:00"],
  ["0 9 * * 7", "Sundays at 09:00"],
  ["0 9 * * 1,3,5", "Mondays, Wednesdays and Fridays at 09:00"],
  ["0 8 1 * *", "Monthly on the 1st at 08:00"],
  ["0 8 22 * *", "Monthly on the 22nd at 08:00"],
  ["0 8 11 * *", "Monthly on the 11th at 08:00"],
  ["0 8 1 1 *", "0 8 1 1 *"],
  ["0 25 * * *", "0 25 * * *"],
  ["0 9 * *", "0 9 * *"],
])("cron %s reads as %s", (cron, words) => {
  expect(cronInWords(cron)).toBe(words)
})

test("a schedule summary names its zone, and no triggers means run-now only", () => {
  expect(triggerSummary({ id: "t", kind: "schedule", cron: "0 9 * * 1-5", tz: "Europe/Berlin", nextAt: null })).toBe(
    "Weekdays at 09:00 · Europe/Berlin",
  )
  expect(describeTriggers({ triggers: [] })).toBe("Run now only")
})

test("each run status lands on a Signal state", () => {
  expect(runSignal("queued")).toBe("queued")
  expect(runSignal("running")).toBe("working")
  expect(runSignal("delivered")).toBe("done")
  expect(runSignal("completed")).toBe("done")
  expect(runSignal("failed")).toBe("failed")
  expect(runSignal("cancelled")).toBe("idle")
})

const now = Date.parse("2026-11-16T10:00:00.000Z")

test("next run reads paused, on webhook, minutes away, a weekday this week, then a date", () => {
  const base = { enabled: true, triggers: [] }
  expect(nextLabel({ ...base, enabled: false, nextAt: "2026-11-16T10:30:00.000Z" }, now)).toBe("Paused")
  expect(nextLabel({ enabled: true, nextAt: null, triggers: [{ id: "w", kind: "webhook", path: "/hooks/x" }] }, now)).toBe("On webhook")
  expect(nextLabel({ ...base, nextAt: null }, now)).toBe("Not scheduled")
  expect(nextLabel({ ...base, nextAt: "2026-11-16T10:00:20.000Z" }, now)).toBe("Now")
  expect(nextLabel({ ...base, nextAt: "2026-11-16T10:12:00.000Z" }, now)).toBe("In 12m")
  expect(nextLabel({ ...base, nextAt: "2026-11-17T02:00:00.000Z" }, now, "UTC")).toBe("Tue 02:00")
  expect(nextLabel({ ...base, nextAt: "2026-12-01T02:00:00.000Z" }, now, "UTC")).toBe("1 Dec")
})

test("the dialog creates one schedule trigger in the browser zone, trimmed", () => {
  const draft = { title: " Digest ", prompt: " Summarise ", cron: " 0  9 * * 1 ", project: "prj_1", target: "fresh" as const }
  expect(draftReady(draft)).toBe(true)
  expect(draftReady({ ...draft, project: "" })).toBe(false)
  expect(draftReady({ ...draft, cron: "  " })).toBe(false)
  expect(createArgs(draft, "Asia/Kolkata")).toEqual({
    title: "Digest",
    prompt: "Summarise",
    project: "prj_1",
    target: { kind: "fresh" },
    triggers: [{ kind: "schedule", cron: "0 9 * * 1", tz: "Asia/Kolkata" }],
  })
})
