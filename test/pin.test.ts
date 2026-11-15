import { describe, expect, it } from "vitest"
import { integrityProblem, permissionProblem, sha512Of, tarballProblem } from "../scripts/pin.ts"

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

describe("plugin sync pins", () => {
  it("refuses tarball bytes other than the ones the owner consented to, before anything is installed", async () => {
    const bytes = new TextEncoder().encode("the consented tarball")
    const consented = await sha512Of(bytes)
    expect(consented).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
    expect(await tarballProblem("@acme/weather@1.2.0", consented, bytes)).toBeUndefined()
    expect(await tarballProblem("@acme/weather@1.2.0", consented, new TextEncoder().encode("swapped"))).toContain(
      "the owner consented to",
    )
  })

  it("refuses an installed package that declares a permission the owner did not approve", () => {
    const manifest = { ingle: { plugins: { weather: { module: "./index.ts", permissions: ["network", "secrets"] } } } }
    expect(permissionProblem("@acme/weather@1.2.0", ["network", "secrets"], manifest)).toBeUndefined()
    expect(permissionProblem("@acme/weather@1.2.0", ["network"], manifest)).toContain("declares secrets")
    expect(permissionProblem("@acme/weather@1.2.0", [], { ingle: { plugins: { weather: {} } } })).toBeUndefined()
  })
})
