import { describe, expect, it } from "vitest"
import { assertUniquePackages } from "../scripts/discovery.ts"

describe("plugin discovery", () => {
  it("refuses a second package that takes a first-party package's name", () => {
    expect(() =>
      assertUniquePackages([
        { pkg: "ingle-plugin-automations", at: "plugins/automations" },
        { pkg: "ingle-plugin-automations", at: "node_modules/ingle-plugin-automations" },
      ]),
    ).toThrow(/found at both plugins\/automations and node_modules/)
    expect(() =>
      assertUniquePackages([
        { pkg: "a", at: "plugins/a" },
        { pkg: "b", at: "plugins/b" },
      ]),
    ).not.toThrow()
  })
})
