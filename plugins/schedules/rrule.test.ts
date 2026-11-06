import { describe, expect, it } from "vitest"
import { parseRule, RuleError, slotsOf } from "./rrule.ts"

const iso = (ms: number): string => new Date(ms).toISOString()
const slots = (rrule: string, tz: string, anchor: number) => slotsOf({ kind: "rrule", rrule }, tz, anchor)

describe("rrule next slot", () => {
  it("keeps a daily wall time across a spring-forward change", () => {
    const rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
    const anchor = Date.parse("2026-03-06T14:00:00Z")
    const first = slots(rule, "America/New_York", anchor).next(anchor, 0)
    expect(first === undefined ? undefined : iso(first.slot)).toBe("2026-03-07T14:00:00.000Z")
    const second = slots(rule, "America/New_York", anchor).next(first?.slot ?? 0, 1)
    expect(second === undefined ? undefined : iso(second.slot)).toBe("2026-03-08T13:00:00.000Z")
  })

  it("moves a wall time that spring-forward removes to the pre-gap offset", () => {
    const rule = "FREQ=DAILY;BYHOUR=2;BYMINUTE=30"
    const anchor = Date.parse("2026-03-07T07:30:00Z")
    const first = slots(rule, "America/New_York", anchor).next(anchor, 0)
    expect(first === undefined ? undefined : iso(first.slot)).toBe("2026-03-08T07:30:00.000Z")
    const second = slots(rule, "America/New_York", anchor).next(first?.slot ?? 0, 1)
    expect(second === undefined ? undefined : iso(second.slot)).toBe("2026-03-09T06:30:00.000Z")
  })

  it("keeps an hourly schedule alive through a half-hour spring-forward", () => {
    const anchor = Date.parse("2026-10-03T15:45:00Z")
    const next = slots("FREQ=HOURLY;BYMINUTE=0", "Australia/Lord_Howe", anchor).next(anchor, 0)
    expect(next === undefined ? undefined : iso(next.slot)).toBe("2026-10-03T16:30:00.000Z")
  })

  it("walks BYDAY across weeks", () => {
    const rule = "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0"
    const anchor = Date.parse("2026-01-01T00:00:00Z")
    const monday = slots(rule, "UTC", anchor).next(anchor, 0)
    expect(monday === undefined ? undefined : iso(monday.slot)).toBe("2026-01-05T09:00:00.000Z")
    const wednesday = slots(rule, "UTC", anchor).next(monday?.slot ?? 0, 1)
    expect(wednesday === undefined ? undefined : iso(wednesday.slot)).toBe("2026-01-07T09:00:00.000Z")
    const nextMonday = slots(rule, "UTC", anchor).next(wednesday?.slot ?? 0, 2)
    expect(nextMonday === undefined ? undefined : iso(nextMonday.slot)).toBe("2026-01-12T09:00:00.000Z")
  })

  it("stops after COUNT occurrences", () => {
    const rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=2"
    const anchor = Date.parse("2026-01-01T00:00:00Z")
    const first = slots(rule, "UTC", anchor).next(anchor, 0)
    const second = slots(rule, "UTC", anchor).next(first?.slot ?? 0, 1)
    expect(first === undefined ? undefined : iso(first.slot)).toBe("2026-01-01T09:00:00.000Z")
    expect(second === undefined ? undefined : iso(second.slot)).toBe("2026-01-02T09:00:00.000Z")
    expect(slots(rule, "UTC", anchor).next(second?.slot ?? 0, 2)).toBeUndefined()
  })

  it("honours COUNT from a checkpoint index instead of walking", () => {
    const anchor = Date.parse("2024-01-01T00:00:00Z")
    const rule = slots("FREQ=HOURLY;BYMINUTE=0;COUNT=3", "UTC", anchor)
    const first = rule.next(anchor - 1, 0)
    const second = rule.next(first?.slot ?? 0, 1)
    const third = rule.next(second?.slot ?? 0, 2)
    expect(first).toEqual({ slot: Date.parse("2024-01-01T00:00:00Z"), index: 0 })
    expect(second).toEqual({ slot: Date.parse("2024-01-01T01:00:00Z"), index: 1 })
    expect(third).toEqual({ slot: Date.parse("2024-01-01T02:00:00Z"), index: 2 })
    expect(rule.next(third?.slot ?? 0, 3)).toBeUndefined()
  })

  it("starts at the period containing after, however old the anchor", () => {
    const anchor = Date.parse("1926-01-01T00:00:00Z")
    const next = slots("FREQ=HOURLY;BYMINUTE=0", "UTC", anchor).next(Date.parse("2026-01-01T10:00:00Z"), 0)
    expect(next).toEqual({ slot: Date.parse("2026-01-01T11:00:00Z"), index: 0 })
  })

  it("stops after UNTIL", () => {
    const rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260102T090000Z"
    const anchor = Date.parse("2026-01-01T00:00:00Z")
    const first = slots(rule, "UTC", anchor).next(anchor, 0)
    const second = slots(rule, "UTC", anchor).next(first?.slot ?? 0, 1)
    expect(first === undefined ? undefined : iso(first.slot)).toBe("2026-01-01T09:00:00.000Z")
    expect(second === undefined ? undefined : iso(second.slot)).toBe("2026-01-02T09:00:00.000Z")
    expect(slots(rule, "UTC", anchor).next(second?.slot ?? 0, 2)).toBeUndefined()
  })

  it("skips months without the anchor day", () => {
    const anchor = Date.parse("2026-01-31T00:00:00Z")
    const next = slots("FREQ=MONTHLY", "UTC", anchor).next(anchor, 0)
    expect(next === undefined ? undefined : iso(next.slot)).toBe("2026-03-31T00:00:00.000Z")
  })

  it("steps hours and honors INTERVAL", () => {
    const anchor = Date.parse("2026-01-01T10:20:00Z")
    const next = slots("FREQ=HOURLY;BYMINUTE=15", "UTC", anchor).next(anchor, 0)
    expect(next === undefined ? undefined : iso(next.slot)).toBe("2026-01-01T11:15:00.000Z")
    const later = slots("FREQ=HOURLY;INTERVAL=2;BYMINUTE=15", "UTC", anchor).next(anchor, 0)
    expect(later === undefined ? undefined : iso(later.slot)).toBe("2026-01-01T12:15:00.000Z")
  })

  it("collapses a downtime window into a count and the latest slot", () => {
    const anchor = Date.parse("2026-01-01T00:00:00Z")
    const due = slots("FREQ=HOURLY;BYMINUTE=0", "UTC", anchor).due(anchor - 1, 0, Date.parse("2026-01-01T02:30:00Z"))
    expect(due).toEqual({ count: 3, latest: Date.parse("2026-01-01T02:00:00Z"), index: 2 })
  })

  it("counts a one-shot slot once", () => {
    const at = Date.parse("2026-01-01T09:00:00Z")
    const one = slotsOf({ kind: "at", at }, "UTC", at - 1000)
    expect(one.next(at - 1, 0)).toEqual({ slot: at, index: 0 })
    expect(one.next(at, 0)).toBeUndefined()
    expect(one.due(at - 1, 0, at - 1)).toBeUndefined()
    expect(one.due(at - 1, 0, at)).toEqual({ count: 1, latest: at, index: 0 })
    expect(one.due(at, 0, at + 60_000)).toBeUndefined()
  })
})

describe("rrule parsing", () => {
  it("rejects unsupported and malformed parts", () => {
    expect(() => parseRule("")).toThrow(RuleError)
    expect(() => parseRule("INTERVAL=2")).toThrow(RuleError)
    expect(() => parseRule("FREQ=YEARLY")).toThrow(RuleError)
    expect(() => parseRule("FREQ=DAILY;BYMONTH=1")).toThrow(RuleError)
    expect(() => parseRule("FREQ=DAILY;BYDAY=1MO")).toThrow(RuleError)
    expect(() => parseRule("FREQ=DAILY;COUNT=1;UNTIL=20260101T000000Z")).toThrow(RuleError)
    expect(() => parseRule("FREQ=HOURLY;BYHOUR=9")).toThrow(RuleError)
    expect(() => parseRule("FREQ=DAILY;INTERVAL=0")).toThrow(RuleError)
    expect(() => parseRule("FREQ=DAILY;BYHOUR=24")).toThrow(RuleError)
  })

  it("accepts an RRULE prefix and defaults", () => {
    const rule = parseRule("RRULE:FREQ=WEEKLY;BYDAY=MO,FR")
    expect(rule).toEqual({ freq: "WEEKLY", interval: 1, byday: ["MO", "FR"], byhour: [], byminute: [] })
  })
})
