import { describe, expect, it } from "vitest"
import { DEV_KEK } from "../scripts/devvars.ts"
import { Sealer } from "../src/seal.ts"

describe("plugin dev without .dev.vars", () => {
  it("runs with a KEK the secrets service accepts, so the Home boots and seals a credential", async () => {
    const sealer = new Sealer(DEV_KEK)
    expect(await sealer.unseal(await sealer.seal("s3cret", "provider:x"), "provider:x")).toBe("s3cret")
  })
})
