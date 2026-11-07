import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, turn } from "../../test/support.ts"

const TEXT = "Answer in plain English. Keep sentences short. PREFER-PLAIN-ENGLISH."

const insert = (stub: ReturnType<typeof fresh>, id: string, config: { text: string }) =>
  cmd(stub, `prompt-insert-${id}-${crypto.randomUUID()}`, "plugin.insert", { id, plugin: "prompt", config })

describe("prompt", () => {
  it("adds a row's text to the model's system prompt", async () => {
    const stub = fresh()
    const inserted = await cmd(stub, `prompt-insert-${crypto.randomUUID()}`, "plugin.insert", {
      id: "house-style",
      plugin: "prompt",
      config: { text: TEXT },
    })
    expect(inserted.result).toMatchObject({ application: "applied" })

    const offers = recordOffers()
    respond([offers.step("ok")])
    await turn(stub, `prompt-turn-${crypto.randomUUID()}`)

    expect(offers.latest().system).toContain(TEXT)
  })

  it("removes the section when the row is disabled and restores it when enabled", async () => {
    const stub = fresh()
    await cmd(stub, `prompt-insert-${crypto.randomUUID()}`, "plugin.insert", {
      id: "house-style",
      plugin: "prompt",
      config: { text: TEXT },
    })
    const offers = recordOffers()
    respond([offers.step("one")])
    await turn(stub, `prompt-turn-${crypto.randomUUID()}`)
    expect(offers.at(0).system).toContain(TEXT)

    const off = await cmd(stub, `prompt-off-${crypto.randomUUID()}`, "plugin.enable", {
      id: "house-style",
      enabled: false,
    })
    expect(off.result).toMatchObject({ application: "applied", row: { disabled: true } })

    respond([offers.step("two")])
    await turn(stub, `prompt-turn-${crypto.randomUUID()}`)
    expect(offers.at(1).system).not.toContain(TEXT)

    await cmd(stub, `prompt-on-${crypto.randomUUID()}`, "plugin.enable", { id: "house-style", enabled: true })

    respond([offers.step("three")])
    await turn(stub, `prompt-turn-${crypto.randomUUID()}`)
    expect(offers.at(2).system).toContain(TEXT)
  })

  it("rejects text longer than 16 KiB at insert", async () => {
    const reply = await insert(fresh(), "too-big", { text: "x".repeat(16_385) })
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("16384") },
    })
  })

  it("requires text", async () => {
    const reply = await cmd(fresh(), `prompt-empty-${crypto.randomUUID()}`, "plugin.insert", {
      id: "no-text",
      plugin: "prompt",
      config: {},
    })
    expect(reply).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })
})
