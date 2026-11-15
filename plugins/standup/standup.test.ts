import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"

describe("standup", () => {
  it("contributes the /standup prompt from its row", async () => {
    const prompts = await cmd(fresh(), "standup-prompts", "prompt.list")
    expect(prompts.result).toContainEqual(
      expect.objectContaining({ name: "standup", source: { kind: "row", row: "standup" } }),
    )
  })
})
