import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowState, turn } from "../../test/support.ts"

describe("tool-models row", () => {
  it("offers set_model only while tool-models is active, and leaves the models service running", async () => {
    const stub = fresh()
    const offers = recordOffers()

    respond([offers.step("first")])
    await turn(stub, "row-turn-1", { text: "hello" })
    expect(offers.at(0).tools).toContain("set_model")

    expect(await cmd(stub, "row-disable", "plugin.enable", { id: "tool-models", enabled: false })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "disabled" } } },
    })
    expect(await rowState(stub, "models")).toEqual({ kind: "active" })
    expect(await rowState(stub, "tool-models")).toEqual({ kind: "disabled" })
    expect(await cmd(stub, "row-default", "owner.defaults", { role: "chat", model: M8_MODEL })).toMatchObject({
      ok: true,
      result: { role: "chat", model: M8_MODEL },
    })
    expect((await cmd(stub, "row-list", "models.list", {})).ok).toBe(true)

    offers.seen.length = 0
    respond([offers.step("second")])
    await turn(stub, "row-turn-2", { text: "what models are there" })
    expect(offers.at(0).tools).not.toContain("set_model")

    expect(await cmd(stub, "row-enable", "plugin.enable", { id: "tool-models", enabled: true })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "active" } } },
    })

    offers.seen.length = 0
    respond([offers.step("third")])
    await turn(stub, "row-turn-3", { text: "switch models" })
    expect(offers.at(0).tools).toContain("set_model")
  }, 30_000)
})
