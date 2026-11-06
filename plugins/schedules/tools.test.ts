import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowOf, setRow, turn } from "../../test/support.ts"

describe("tool-schedules row", () => {
  it("offers the schedule tools only while its row is active and leaves the service running", async () => {
    const stub = fresh()
    const offers = recordOffers()

    respond([offers.step()])
    await turn(stub, `turn-${crypto.randomUUID()}`)
    expect(offers.latest().tools).toEqual(expect.arrayContaining(["schedule", "unschedule"]))

    await setRow(stub, "tool-schedules", false)
    expect(await rowOf(stub, "schedules")).toMatchObject({ disabled: false, state: { kind: "active" } })
    expect(await rowOf(stub, "tool-schedules")).toMatchObject({ disabled: true, state: { kind: "disabled" } })

    respond([offers.step()])
    await turn(stub, `turn-${crypto.randomUUID()}`)
    const hidden = offers.latest().tools
    expect(hidden).not.toContain("schedule")
    expect(hidden).not.toContain("unschedule")

    const at = Date.now() + 600_000
    const created = await cmd(stub, "create", "schedule.create", { id: "kept", at, tz: "UTC", prompt: "ping" })
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { id: "kept", created: true } })
    const listed = await cmd(stub, "list-live", "schedule.list")
    expect(JSON.stringify(listed.result)).toContain('"id":"kept"')

    await setRow(stub, "tool-schedules", true)
    respond([offers.step()])
    await turn(stub, `turn-${crypto.randomUUID()}`)
    expect(offers.latest().tools).toEqual(expect.arrayContaining(["schedule", "unschedule"]))
    expect(await rowOf(stub, "tool-schedules")).toMatchObject({
      disabled: false,
      state: { kind: "active" },
    })
  })
})
