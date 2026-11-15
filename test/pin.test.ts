import { describe, expect, it } from "vitest"
import {
  gitProblem,
  integrityProblem,
  permissionProblem,
  sha512Of,
  specProblem,
  tarballProblem,
} from "../scripts/pin.ts"

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

const COMMIT = "666df7c10035f7e26f27ec214fe5ae3173435f34"
const SHIPPED = new Set(["ingle-plugin-git"])
const gitLock = (spec: string, name: string, built: string): string => `{
  "lockfileVersion": 2,
  "workspaces": { "": { "name": "ingle", "dependencies": { "${name}": "${spec}", }, }, },
  "packages": {
    "${name}": ["${name}@github:acme/tools#${built}", {}, "acme-tools-${built}", "sha512-x"],
  },
}
`

describe("plugin sync git pins and first-party names", () => {
  it("refuses a git spec with no ref or a branch, and a registry name the build ships, before fetching", () => {
    expect(specProblem("github:acme/tools", SHIPPED)).toContain("40-hex commit")
    expect(specProblem("github:acme/tools#main", SHIPPED)).toContain("40-hex commit")
    expect(specProblem(`github:acme/tools#${COMMIT}`, SHIPPED)).toBeUndefined()
    expect(specProblem("ingle-plugin-git@9.9.9", SHIPPED)).toContain("ships with this build")
    expect(specProblem("@acme/weather@1.2.0", SHIPPED)).toBeUndefined()
  })

  it("accepts the pinned commit and refuses another commit or a first-party name", () => {
    const spec = `github:acme/tools#${COMMIT}`
    expect(gitProblem(spec, gitLock(spec, "acme-tools", "666df7c"), SHIPPED)).toBeUndefined()
    expect(gitProblem(spec, gitLock(spec, "acme-tools", "1234567"), SHIPPED)).toContain("resolved 1234567")
    expect(gitProblem(spec, gitLock(spec, "ingle-plugin-git", "666df7c"), SHIPPED)).toContain("ships with this build")
    expect(gitProblem(spec, gitLock("github:other/x", "acme-tools", "666df7c"), SHIPPED)).toContain("no dependency")
  })
})
