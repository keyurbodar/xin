import { describe, expect, it } from "vitest"
import { Sealer } from "./seal.ts"

const KEK = btoa("k".repeat(32))

describe("the sealer", () => {
  it("binds a sealed value to the label it was sealed under", async () => {
    const sealer = new Sealer(KEK)
    const sealed = await sealer.seal("plain", "credential:TOKEN")
    expect(await sealer.unseal(sealed, "credential:TOKEN")).toBe("plain")
    await expect(sealer.unseal(sealed, "credential:OTHER")).rejects.toThrow()
  })
})
