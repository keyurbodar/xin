import type { AssistantMessage, FauxResponseFactory, TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { answer, respond, tool } from "../../test/plugins/m8.ts"
import { cmd, fresh, rowState, turn } from "../../test/support.ts"
import { createTimestampFormatter, formatDuration, formatTimestamp, renderReading } from "./index.ts"

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const usersOf = (context: TranscriptContext): string[] =>
  context.messages.flatMap((message) => (message.role === "user" ? [textOf(message.content)] : []))

const reader = () => {
  const requests: string[][] = []
  return {
    requests,
    step:
      (response: AssistantMessage): FauxResponseFactory =>
      (context) => {
        requests.push(usersOf(context))
        return response
      },
    clear: (): void => {
      requests.splice(0)
    },
  }
}

const readings = (users: readonly string[] | undefined): string[] =>
  (users ?? []).filter((text) => text.startsWith("Time sampled"))

describe("clock", () => {
  it("appends one reading before the first request of a turn", async () => {
    const stub = fresh()
    const rec = reader()
    respond([rec.step(answer("ok"))])
    await turn(stub, `clock-${crypto.randomUUID()}`)

    const users = rec.requests.at(-1) ?? []
    expect(users).toHaveLength(2)
    const reading = users.at(-1) ?? ""
    expect(reading).toContain("Time sampled while preparing turn 1, step 1: ")
    expect(reading).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00\[UTC\]/)
    expect(reading).toContain("\nOwner time zone: UTC. Interpret otherwise-unqualified dates and times in this zone.\n")
    expect(reading).toMatch(/\nElapsed since the preceding model-visible message: \d+s\.$/)
  })

  it("writes no second reading inside refreshIntervalMs", async () => {
    const stub = fresh()
    const rec = reader()
    respond([rec.step(answer("ok"))])
    await turn(stub, `clock-${crypto.randomUUID()}`)
    expect(readings(rec.requests.at(-1))).toHaveLength(1)

    rec.clear()
    respond([rec.step(answer("still ok"))])
    await turn(stub, `clock-${crypto.randomUUID()}`)
    expect(readings(rec.requests.at(-1))).toEqual([])
  })

  it("writes one before every request when refreshIntervalMs is 0, measuring later ones from the reading", async () => {
    const stub = fresh()
    const configured = await cmd(stub, "clock-zero", "plugin.configure", {
      id: "time",
      config: { timezone: "UTC", refreshIntervalMs: 0 },
    })
    expect(configured.result).toMatchObject({ application: "applied", row: { state: { kind: "active" } } })

    const rec = reader()
    respond([rec.step(tool("ping")), rec.step(answer("done"))])
    await turn(stub, `clock-${crypto.randomUUID()}`)

    const [first, second] = rec.requests
    expect(readings(first)).toHaveLength(1)
    expect(readings(second)).toHaveLength(1)
    expect(first?.at(-1)).toContain("Time sampled while preparing turn 1, step 1: ")
    expect(first?.at(-1)).toContain("Elapsed since the preceding model-visible message: ")
    expect(second?.at(-1)).toContain("Time sampled while preparing turn 1, step 2: ")
    expect(second?.at(-1)).toContain("Elapsed since the preceding step context: ")
    expect(second?.at(-1)).not.toContain("unavailable")
  })

  it("fails the row at load when the zone is invalid, and the conversation still runs", async () => {
    const stub = fresh()
    const failed = await cmd(stub, "clock-zone", "plugin.configure", {
      id: "time",
      config: { timezone: "Not/AZone" },
    })
    expect(failed.result).toMatchObject({ application: "failed", row: { state: { kind: "failed" } } })
    expect(await rowState(stub, "time")).toMatchObject({ kind: "failed" })

    const rec = reader()
    respond([rec.step(answer("ok"))])
    await turn(stub, `clock-${crypto.randomUUID()}`)
    expect(readings(rec.requests.at(-1))).toEqual([])
  })

  it("mounts a row from its own bundle beside the composed default row", async () => {
    const stub = fresh()
    const put = await cmd(stub, "clock-put", "bundle.put", {
      package: "xin-test-time-tokyo",
      rows: [{ id: "time-tokyo", plugin: "time", config: { timezone: "Asia/Tokyo" } }],
    })
    expect(put.result).toMatchObject({ application: "applied" })
    expect(await rowState(stub, "time")).toEqual({ kind: "active" })
    expect(await rowState(stub, "time-tokyo")).toEqual({ kind: "active" })

    const rec = reader()
    respond([rec.step(answer("ok"))])
    await turn(stub, `clock-${crypto.randomUUID()}`)
    const written = readings(rec.requests.at(-1))
    expect(written).toHaveLength(2)
    expect(written.some((text) => text.includes("Owner time zone: Asia/Tokyo."))).toBe(true)
    expect(written.some((text) => text.includes("[Asia/Tokyo]"))).toBe(true)
    expect(written.some((text) => text.includes("Owner time zone: UTC."))).toBe(true)
  })
})

describe("clock reading", () => {
  it("formats a timestamp with a numeric offset and the IANA zone", () => {
    const now = Date.UTC(2026, 10, 7, 3, 12, 44)
    expect(formatTimestamp(now, createTimestampFormatter("UTC"), "UTC")).toBe("2026-11-07T03:12:44+00:00[UTC]")
    expect(formatTimestamp(now, createTimestampFormatter("Europe/Berlin"), "Europe/Berlin")).toBe(
      "2026-11-07T04:12:44+01:00[Europe/Berlin]",
    )
  })

  it("keeps non-zero leading units plus seconds", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(4_000)).toBe("4s")
    expect(formatDuration(72_000)).toBe("1m 12s")
    expect(formatDuration(86_400_000 + 2 * 3_600_000 + 3 * 60_000 + 4_000)).toBe("1d 2h 3m 4s")
  })

  it("clamps a backward clock to zero and renders unavailable without a baseline", () => {
    const formatter = createTimestampFormatter("UTC")
    const now = Date.UTC(2026, 10, 7, 3, 12, 44)
    expect(renderReading({ now, turn: 4, step: 2, previous: now - 72_000, timeZone: "UTC", formatter })).toBe(
      "Time sampled while preparing turn 4, step 2: 2026-11-07T03:12:44+00:00[UTC]\n" +
        "Owner time zone: UTC. Interpret otherwise-unqualified dates and times in this zone.\n" +
        "Elapsed since the preceding step context: 1m 12s.",
    )
    expect(renderReading({ now, turn: 1, step: 1, previous: undefined, timeZone: "UTC", formatter })).toContain(
      "Elapsed since the preceding model-visible message: unavailable.",
    )
    expect(renderReading({ now, turn: 1, step: 1, previous: now + 5_000, timeZone: "UTC", formatter })).toContain(
      "Elapsed since the preceding model-visible message: 0s.",
    )
  })
})
