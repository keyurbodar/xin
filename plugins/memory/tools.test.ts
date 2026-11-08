import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowState, turn } from "../../test/support.ts"

const MEMORY_TOOLS = ["remember", "recall"]
const NOTE = { scope: "me", text: "The owner's dog is named Miso" }

const call = (name: string, args: Record<string, string>): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

describe("memory tool row", () => {
  it("offers the memory tools while both rows are active", async () => {
    const stub = fresh()
    const offers = recordOffers()
    respond([offers.step("ok")])
    await turn(stub, "p3-memory-active")
    for (const name of MEMORY_TOOLS) expect(offers.latest().tools).toContain(name)
  })

  it("removes exactly the memory tools when only the tool row is disabled, and restores them", async () => {
    const stub = fresh()
    const offers = recordOffers()

    respond([call("remember", { ...NOTE }), offers.step("noted")])
    await turn(stub, "p3-memory-remember")
    expect((await cmd(stub, "p3-memory-list-1", "memory.list")).result).toMatchObject({ notes: [NOTE] })

    const disabled = await cmd(stub, "p3-memory-disable", "plugin.enable", { id: "tool-memory", enabled: false })
    expect(disabled.result).toMatchObject({ application: "applied" })
    expect(await rowState(stub, "tool-memory")).toEqual({ kind: "disabled" })
    expect(await rowState(stub, "memory")).toEqual({ kind: "active" })

    respond([offers.step("ok")])
    await turn(stub, "p3-memory-off")
    const without = offers.latest().tools
    for (const name of MEMORY_TOOLS) expect(without).not.toContain(name)
    expect(without).toContain("capabilities")

    expect((await cmd(stub, "p3-memory-list-2", "memory.list")).result).toMatchObject({ notes: [NOTE] })

    const enabled = await cmd(stub, "p3-memory-enable", "plugin.enable", { id: "tool-memory", enabled: true })
    expect(enabled.result).toMatchObject({ application: "applied" })
    respond([offers.step("ok")])
    await turn(stub, "p3-memory-on")
    for (const name of MEMORY_TOOLS) expect(offers.latest().tools).toContain(name)
  })
})
