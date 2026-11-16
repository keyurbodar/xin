import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"

const STANDUP = expect.objectContaining({ name: "standup", source: { kind: "row", row: "standup" } })

describe("standup", () => {
  it("ships disabled, and contributes the /standup prompt from its row once enabled", async () => {
    const stub = fresh()
    expect((await cmd(stub, "standup-off", "prompt.list")).result).not.toContainEqual(STANDUP)
    await cmd(stub, "standup-enable", "plugin.enable", { id: "standup", enabled: true })
    expect((await cmd(stub, "standup-on", "prompt.list")).result).toContainEqual(STANDUP)
  })
})
