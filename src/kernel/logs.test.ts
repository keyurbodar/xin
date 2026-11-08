import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { captureLogs, type LogRing } from "./logs.ts"

const target = console

describe("captureLogs", () => {
  let savedWarn = target.warn
  let savedError = target.error
  let ring: LogRing | undefined

  beforeEach(() => {
    savedWarn = target.warn
    savedError = target.error
  })

  afterEach(() => {
    ring?.stop()
    ring = undefined
    target.warn = savedWarn
    target.error = savedError
  })

  it("captures warnings and errors with their level and rendered text", () => {
    ring = captureLogs()
    target.warn("first", 2)
    target.error("second")
    expect(ring.entries()).toMatchObject([
      { level: "warn", text: "first 2" },
      { level: "error", text: "second" },
    ])
    expect(ring.entries().every((entry) => entry.at > 0)).toBe(true)
  })

  it("caps each entry's text at 4000 characters", () => {
    ring = captureLogs()
    target.warn("x".repeat(5_000))
    expect(ring.entries()[0]?.text).toHaveLength(4_000)
  })

  it("keeps the newest entries up to the limit", () => {
    ring = captureLogs(3)
    for (const message of ["a", "b", "c", "d"]) target.warn(message)
    expect(ring.entries().map((entry) => entry.text)).toEqual(["b", "c", "d"])
  })

  it("still calls the original", () => {
    const calls: unknown[][] = []
    target.warn = (...args: unknown[]) => {
      calls.push(args)
    }
    ring = captureLogs()
    target.warn("kept", 2)
    expect(calls).toEqual([["kept", 2]])
  })

  it("restores the console on stop and tolerates a second stop", () => {
    const calls: unknown[][] = []
    target.warn = (...args: unknown[]) => {
      calls.push(args)
    }
    const capture = captureLogs()
    ring = capture
    target.warn("before stop")
    expect(capture.entries().map((entry) => entry.text)).toEqual(["before stop"])
    capture.stop()
    target.warn("after stop")
    expect(capture.entries().map((entry) => entry.text)).toEqual(["before stop"])
    expect(calls).toEqual([["before stop"], ["after stop"]])
    expect(() => capture.stop()).not.toThrow()
    ring = undefined
  })

  it("records the entry even when the original throws", () => {
    target.warn = () => {
      throw new Error("console exploded")
    }
    ring = captureLogs()
    expect(() => target.warn("during a throw")).toThrow("console exploded")
    expect(ring.entries().map((entry) => entry.text)).toEqual(["during a throw"])
  })
})
