import { expect, test } from "bun:test"
import {
  attemptFor,
  automationsRevisionOf,
  automationsTouchedOf,
  batchGroupLabel,
  createArgs,
  cronInWords,
  CRON_MAX_LENGTH,
  cronProblem,
  keepUnchanged,
  describeTriggers,
  draftOf,
  draftReady,
  localInput,
  mergeRuns,
  newTrigger,
  nextLabel,
  parseAutomationDetail,
  parseAutomationList,
  parseRuns,
  rotated,
  spentOnce,
  runDuration,
  runNowArgs,
  runSignal,
  triggerSummary,
  untilLabel,
  updateArgs,
  webhookUrl,
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
  expect(list[0]?.lastRun).toMatchObject({ id: "r1", status: "failed", source: "manual", threadId: null, inputs: 0, error: "boom" })
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
  ["*/45 * * * *", "*/45 * * * *"],
  ["0 */5 * * *", "0 */5 * * *"],
  ["*/0 * * * *", "*/0 * * * *"],
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
  expect(nextLabel({ enabled: true, nextAt: null, triggers: [{ id: "w", kind: "webhook", path: "/hooks/x", contains: [], regex: null, rules: [] }] }, now)).toBe("On webhook")
  expect(nextLabel({ ...base, nextAt: null }, now)).toBe("Not scheduled")
  expect(nextLabel({ ...base, nextAt: "2026-11-16T10:00:20.000Z" }, now)).toBe("Now")
  expect(nextLabel({ ...base, nextAt: "2026-11-16T10:12:00.000Z" }, now)).toBe("In 12m")
  expect(nextLabel({ ...base, nextAt: "2026-11-17T02:00:00.000Z" }, now, "UTC")).toBe("Tue 02:00")
  expect(nextLabel({ ...base, nextAt: "2026-12-01T02:00:00.000Z" }, now, "UTC")).toBe("1 Dec")
})

const parsed = parseAutomationList({ automations: [wire] })[0]
if (parsed === undefined) throw new Error("fixture did not parse")

test("the dialog creates its triggers trimmed, a schedule in its zone and a new webhook without an id", () => {
  const draft = {
    title: " Digest ",
    prompt: " Summarise ",
    project: "prj_1",
    target: "fresh" as const,
    triggers: [
      { key: "a", kind: "schedule" as const, cron: " 0  9 * * 1 ", tz: "Asia/Kolkata" },
      newTrigger("webhook", "b", "UTC"),
    ],
  }
  expect(draftReady(draft)).toBe(true)
  expect(draftReady({ ...draft, project: "" })).toBe(false)
  expect(draftReady({ ...draft, triggers: [newTrigger("schedule", "c", "UTC")] })).toBe(false)
  expect(draftReady({ ...draft, triggers: [newTrigger("once", "d", "UTC")] })).toBe(false)
  expect(draftReady({ ...draft, triggers: [{ key: "e", kind: "schedule", cron: "*/60 * * * *", tz: "UTC" }] })).toBe(false)
  expect(
    draftReady({ ...draft, triggers: [{ key: "f", kind: "schedule", cron: `${Array.from({ length: 44 }, (_, i) => i).join(",")} * * * *`, tz: "UTC" }] }),
  ).toBe(false)
  expect(createArgs(draft)).toEqual({
    title: "Digest",
    prompt: "Summarise",
    project: "prj_1",
    target: { kind: "fresh" },
    triggers: [{ kind: "schedule", cron: "0 9 * * 1", tz: "Asia/Kolkata" }, { kind: "webhook" }],
  })
})

test("a webhook's filters go as a list and a regex, and its batching rules ride along untouched", () => {
  const hook = { ...newTrigger("webhook", "w", "UTC"), contains: "opened, ,labeled ", regex: " ^ci ", rules: [{ count: 5 }] }
  expect(createArgs({ title: "t", prompt: "p", project: "x", target: "fresh", triggers: [hook] }).triggers).toEqual([
    { kind: "webhook", contains: ["opened", "labeled"], regex: "^ci", rules: [{ count: 5 }] },
  ])
})

test("a once trigger goes as the ISO instant of the local time picked", () => {
  const args = createArgs({ title: "t", prompt: "p", project: "x", target: "fresh", triggers: [{ key: "o", kind: "once", at: "2026-12-01T09:30" }] })
  expect(args.triggers).toEqual([{ kind: "once", at: new Date("2026-12-01T09:30").toISOString() }])
  expect(localInput(new Date("2026-12-01T09:30").toISOString())).toBe("2026-12-01T09:30")
})

test("editing sends only what changed, and an untouched trigger set is not sent at all", () => {
  const draft = draftOf(parsed)
  expect(updateArgs(parsed, draft)).toEqual({ id: "a1" })
  expect(updateArgs(parsed, { ...draft, title: "Gate" })).toEqual({ id: "a1", title: "Gate" })
})

test("an edited trigger set keeps the webhook's id, so its URL survives, and rotating drops it", () => {
  const draft = draftOf(parsed)
  const [schedule, hook] = draft.triggers
  if (schedule?.kind !== "schedule" || hook === undefined) throw new Error("fixture triggers")
  const edited = updateArgs(parsed, { ...draft, triggers: [{ ...schedule, cron: "0 3 * * *" }, hook] })
  expect(edited.triggers).toEqual([{ kind: "schedule", cron: "0 3 * * *", tz: "Asia/Kolkata" }, { kind: "webhook", id: "t2" }])
  expect(updateArgs(parsed, { ...draft, triggers: [schedule, rotated(hook)] }).triggers).toEqual([
    { kind: "schedule", cron: "0 2 * * *", tz: "Asia/Kolkata" },
    { kind: "webhook" },
  ])
})

test("a standing thread keeps its thread when the target is resent, and moving to fresh drops it", () => {
  const fresh = { ...parsed, target: "fresh" as const, threadId: null }
  expect(updateArgs(fresh, { ...draftOf(fresh), target: "same" }).target).toEqual({ kind: "same" })
  expect(updateArgs(parsed, { ...draftOf(parsed), target: "fresh" }).target).toEqual({ kind: "fresh" })
})

test("run now sends the input only when there is some", () => {
  expect(runNowArgs("a1", "  ")).toEqual({ id: "a1" })
  expect(runNowArgs("a1", " ship it ")).toEqual({ id: "a1", input: "ship it" })
})

test("the detail parses runs and open batches, and paging merges older runs once each", () => {
  const run = (id: string) => ({ ...wire.lastRun, id, source: "webhook", inputs: 3, startedAt: "2026-11-16T02:00:00.000Z", finishedAt: "2026-11-16T02:01:12.000Z", cost: 0.42 })
  const detail = parseAutomationDetail({
    ...wire,
    runs: [run("r3"), run("r2")],
    batches: [{ triggerId: "t2", rule: 0, group: "", count: 2, firstAt: "2026-11-16T01:00:00.000Z", closeAt: "2026-11-16T03:00:00.000Z" }, { count: 1 }],
  })
  expect(detail?.runs.map((entry) => entry.id)).toEqual(["r3", "r2"])
  expect(detail?.runs[0]?.source).toBe("webhook")
  expect(detail?.runs[0]?.cost).toBe(0.42)
  expect(detail?.batches).toEqual([{ triggerId: "t2", group: "", count: 2, firstAt: "2026-11-16T01:00:00.000Z", closeAt: "2026-11-16T03:00:00.000Z" }])
  const older = parseRuns({ runs: [run("r2"), run("r1")] })
  expect(mergeRuns(detail?.runs ?? [], older).map((entry) => entry.id)).toEqual(["r3", "r2", "r1"])
  expect(runDuration(detail?.runs[0] ?? run("x"))).toBe("1m 12s")
  expect(runDuration({ startedAt: null, finishedAt: null })).toBeUndefined()
})

test("a webhook URL is the page origin plus the trigger path", () => {
  expect(webhookUrl("https://ingle.example/", "/hooks/abc")).toBe("https://ingle.example/hooks/abc")
})

test("a batch's close reads as time left, and a due one as closing", () => {
  expect(untilLabel("2026-11-16T10:00:30.000Z", now)).toBe("in 30s")
  expect(untilLabel("2026-11-16T10:12:00.000Z", now)).toBe("in 12m")
  expect(untilLabel("2026-11-16T13:00:00.000Z", now)).toBe("in 3h")
  expect(untilLabel("2026-11-16T09:00:00.000Z", now)).toBe("closing")
})

test("a batch group reads as its values, and anything else as it came", () => {
  expect(batchGroupLabel('["keyurbodar/xin","opened"]')).toBe("keyurbodar/xin · opened")
  expect(batchGroupLabel('[null,3]')).toBe("null · 3")
  expect(batchGroupLabel("")).toBe("")
  expect(batchGroupLabel("not json")).toBe("not json")
})

test("the dialog refuses exactly the crons the server's parser refuses, in its words", () => {
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "x * * * *"]) {
    expect(cronProblem(bad, "UTC")).toBeString()
  }
  expect(cronProblem("*/0 * * * *", "UTC")).toBe("0 is outside 1-59")
  expect(cronProblem("*/60 * * * *", "UTC")).toBe("60 is outside 1-59")
  expect(cronProblem("0 */24 * * *", "UTC")).toBe("24 is outside 1-23")
  expect(cronProblem("0 0 31 2 *", "UTC")).toBe('"0 0 31 2 *" never fires')
  expect(cronProblem("*/45 * * * *", "UTC")).toBeUndefined()
  expect(cronProblem("0 9 * * MON-FRI", "UTC")).toBeUndefined()
  const minutes = (n: number) => Array.from({ length: n }, (_, i) => i % 60).join(",")
  const atLimit = `${minutes(43)},1 * * * *`
  expect(atLimit.length).toBe(CRON_MAX_LENGTH)
  expect(cronProblem(atLimit, "UTC")).toBeUndefined()
  expect(`${minutes(44)} * * * *`.length).toBe(CRON_MAX_LENGTH + 1)
  expect(cronProblem(`${minutes(44)} * * * *`, "UTC")).toBe("A schedule is at most 128 characters")
  expect(cronProblem(`  ${minutes(40)}   *  *  *  *  `, "UTC")).toBeUndefined()
})

test("a reload keeps the previous object of each unchanged automation and takes the new one otherwise", () => {
  const [first] = parseAutomationList({ automations: [wire] })
  const [again] = parseAutomationList({ automations: [wire] })
  const [renamed] = parseAutomationList({ automations: [{ ...wire, title: "Renamed" }] })
  if (first === undefined || again === undefined || renamed === undefined) throw new Error("fixture did not parse")
  expect(keepUnchanged([first], [again])[0]).toBe(first)
  expect(keepUnchanged([first], [renamed])[0]).toBe(renamed)
  expect(keepUnchanged(undefined, [again])[0]).toBe(again)
})

const served = {
  ...wire,
  id: "a9",
  project: null,
  target: "same",
  threadId: 4,
  triggers: [
    {
      id: "w1",
      kind: "webhook",
      path: "/hooks/secret",
      contains: ["foo,bar"],
      regex: " ^ci ",
      rules: [{ when: {}, groupBy: ["repo"], count: 5, maxWaitSeconds: null, quietSeconds: 600 }],
    },
    { id: "o1", kind: "once", at: "2026-11-01T09:30:15.250Z", nextAt: null },
    { id: "s1", kind: "schedule", cron: "0 9 * * 1-5", tz: "UTC", nextAt: "2026-11-17T09:00:00.000Z" },
  ],
}
const servedAutomation = parseAutomationList({ automations: [served] })[0]
if (servedAutomation === undefined) throw new Error("served fixture did not parse")

test("rules from automation.get go back without their nulls, so the validator takes them", () => {
  const draft = draftOf(servedAutomation)
  const [hook, , schedule] = draft.triggers
  if (hook?.kind !== "webhook" || schedule?.kind !== "schedule") throw new Error("fixture triggers")
  const args = updateArgs(servedAutomation, { ...draft, triggers: [rotated(hook), schedule] }, now)
  expect(args.triggers).toEqual([
    { kind: "webhook", contains: ["foo", "bar"], regex: "^ci", rules: [{ groupBy: ["repo"], count: 5, quietSeconds: 600 }] },
    { kind: "schedule", cron: "0 9 * * 1-5", tz: "UTC" },
  ])
})

test("an untouched trigger goes back exactly as served while another one changes, and a spent once drops out", () => {
  const draft = draftOf(servedAutomation)
  const [hook, once, schedule] = draft.triggers
  if (hook === undefined || once === undefined || schedule?.kind !== "schedule") throw new Error("fixture triggers")
  expect(spentOnce(once, now)).toBe(true)
  expect(updateArgs(servedAutomation, draft, now)).toEqual({ id: "a9" })
  expect(updateArgs(servedAutomation, { ...draft, triggers: [hook, once, { ...schedule, cron: "0 10 * * 1-5" }] }, now).triggers).toEqual([
    { kind: "webhook", id: "w1", contains: ["foo,bar"], regex: " ^ci ", rules: [{ groupBy: ["repo"], count: 5, quietSeconds: 600 }] },
    { kind: "schedule", cron: "0 10 * * 1-5", tz: "UTC" },
  ])
})

test("an automation outside any project can still be edited, but a new one needs a project", () => {
  const draft = { ...draftOf(servedAutomation), title: "Renamed" }
  expect(draft.project).toBe("")
  expect(draftReady(draft, servedAutomation)).toBe(true)
  expect(draftReady(draft)).toBe(false)
  expect(updateArgs(servedAutomation, draft, now)).toEqual({ id: "a9", title: "Renamed" })
})

test("a retry of the same args reuses its command id, and changed args get a new one", () => {
  let minted = 0
  const mint = () => `c${(minted += 1)}`
  const first = attemptFor(undefined, { id: "a1", input: "x" }, mint)
  expect(first.id).toBe("c1")
  expect(attemptFor(first, { id: "a1", input: "x" }, mint).id).toBe("c1")
  expect(attemptFor(first, { id: "a1", input: "y" }, mint).id).toBe("c2")
})

test("each automation's own revision comes from the home snapshot, ignoring what is not a number", () => {
  expect([...automationsTouchedOf({ automations: { revision: 9, touched: { a1: 7, a2: 9, bad: "x" } } })]).toEqual([
    ["a1", 7],
    ["a2", 9],
  ])
  expect(automationsTouchedOf({ automations: { revision: 1 } }).size).toBe(0)
})
