import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { extensionName, format, toolName } from "./index.ts"

const installed = (stub: DurableObjectStub<Home>): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) => [...home.loader.ctx.pi.installed.keys()].toSorted())

describe("time", () => {
  it("names the row's extension tool-time and keeps the tool current_time", async () => {
    const stub = fresh()
    expect(await installed(stub)).toContain(extensionName("time"))
    const offers = recordOffers()

    respond([offers.step("ok")])
    await turn(stub, `time-turn-${crypto.randomUUID()}`)

    expect(offers.latest().tools).toContain("current_time")
  })

  it("names a second row's extension and tool after the row", async () => {
    const stub = fresh()
    const put = await cmd(stub, `time-put-${crypto.randomUUID()}`, "bundle.put", {
      package: "xin-test-time-tokyo",
      rows: [{ id: "time-tokyo", plugin: "time", config: { timezone: "Asia/Tokyo" } }],
    })
    expect(put.result).toMatchObject({ application: "applied" })
    expect(await installed(stub)).toContain("tool-time-tokyo")
    const offers = recordOffers()

    respond([offers.step("ok")])
    await turn(stub, `time-turn-${crypto.randomUUID()}`)

    expect(offers.latest().tools).toContain("current_time")
    expect(offers.latest().tools).toContain("current_time_time_tokyo")
  })

  it("formats a moment in the configured timezone", () => {
    const text = format(new Date(0), "UTC")
    expect(text).toContain("1970")
    expect(text).toContain("(UTC, 1970-01-01T00:00:00.000Z)")
    expect(toolName("time")).toBe("current_time")
    expect(toolName("time-tokyo")).toBe("current_time_time_tokyo")
  })
})
