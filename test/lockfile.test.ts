import { describe, expect, it } from "vitest"
import { integrityProblem } from "../scripts/lockfile.ts"

const LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "@acme/weather": ["@acme/weather@1.2.0", "", {}, "sha512-good"],
    "linked": ["linked@workspace:plugins/linked"],
  },
}
`

describe("plugin sync integrity", () => {
  it("accepts the bytes the owner consented to", () => {
    expect(integrityProblem("@acme/weather@1.2.0", "sha512-good", LOCK)).toBeUndefined()
  })

  it("refuses a lockfile that resolves other bytes or no registry tarball", () => {
    expect(integrityProblem("@acme/weather@1.2.0", "sha512-other", LOCK)).toContain("resolves sha512-good")
    expect(integrityProblem("linked@1.0.0", "sha512-good", LOCK)).toContain("no registry tarball")
  })
})
