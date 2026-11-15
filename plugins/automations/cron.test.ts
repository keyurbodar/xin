import { describe, expect, it } from "vitest"
import { CronError, nextCron, parseCron } from "./cron.ts"

const at = (text: string): number => Date.parse(text)
const next = (cron: string, tz: string, after: string): string | undefined => {
  const found = nextCron(parseCron(cron), tz, at(after))
  return found === undefined ? undefined : new Date(found).toISOString()
}

describe("cron", () => {
  it("finds the next minute in UTC", () => {
    expect(next("*/15 * * * *", "UTC", "2026-11-15T10:07:30Z")).toBe("2026-11-15T10:15:00.000Z")
    expect(next("0 9 * * MON-FRI", "UTC", "2026-11-14T12:00:00Z")).toBe("2026-11-16T09:00:00.000Z")
    expect(next("0 0 1 JAN *", "UTC", "2026-11-15T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z")
  })

  it("is strictly after the given instant", () => {
    expect(next("0 9 * * *", "UTC", "2026-11-15T09:00:00Z")).toBe("2026-11-16T09:00:00.000Z")
  })

  it("keeps wall-clock time in a zone across daylight saving", () => {
    expect(next("0 9 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe("2026-03-29T07:00:00.000Z")
    expect(next("0 9 * * *", "Europe/Berlin", "2026-03-27T12:00:00Z")).toBe("2026-03-28T08:00:00.000Z")
    expect(next("30 9 * * *", "Asia/Kolkata", "2026-11-15T00:00:00Z")).toBe("2026-11-15T04:00:00.000Z")
  })

  it("skips a local time daylight saving removes", () => {
    expect(next("30 2 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe("2026-03-30T00:30:00.000Z")
  })

  it("matches day of month or weekday when both are restricted", () => {
    expect(next("0 0 13 * 5", "UTC", "2026-11-01T00:00:00Z")).toBe("2026-11-06T00:00:00.000Z")
  })

  it("treats 7 as Sunday", () => {
    expect(next("0 0 * * 7", "UTC", "2026-11-15T01:00:00Z")).toBe("2026-11-22T00:00:00.000Z")
  })

  it("rejects malformed expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "x * * * *"])
      expect(() => parseCron(bad)).toThrow(CronError)
  })

  it("answers nothing for a date that never comes", () => {
    expect(next("0 0 31 2 *", "UTC", "2026-01-01T00:00:00Z")).toBeUndefined()
  })
})
