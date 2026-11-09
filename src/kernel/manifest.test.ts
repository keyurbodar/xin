import { describe, expect, it } from "vitest"
import { checkManifest, DEFAULT_MANIFEST, describeProblem, PLUGIN_API, readManifest } from "./manifest.ts"

const versions = (known: Readonly<Record<string, string>>) => (name: string) => known[name]

describe("plugin manifest", () => {
  it("defaults a plugin that declares nothing to api 1 with no requirements", () => {
    expect(readManifest({}, "xin-plugin-x: xin.plugins.x")).toEqual(DEFAULT_MANIFEST)
  })

  it("keeps a declared requirement", () => {
    expect(readManifest({ requires: ["time@^0.1"] }, "x")).toEqual({
      api: PLUGIN_API,
      requires: ["time@^0.1"],
    })
  })

  it("rejects a value outside the closed vocabulary", () => {
    expect(() => readManifest({ api: 0 }, "x")).toThrow(/api/)
    expect(() => readManifest({ requires: ["time ^1"] }, "x")).toThrow(/requires/)
    expect(() => readManifest({ module: "./index.ts" }, "x")).toThrow()
  })

  it("refuses a build whose plugin API differs from the one the module was written against", () => {
    const problem = checkManifest({ ...DEFAULT_MANIFEST, api: 2 }, versions({}))
    expect(problem).toEqual({ kind: "api", declared: 2, supported: PLUGIN_API })
    expect(describeProblem(problem!)).toContain("API 2")
  })

  it("refuses a missing required plugin and a version outside the range", () => {
    const requires = { ...DEFAULT_MANIFEST, requires: ["time@^0.1", "memory@^2"] }
    expect(checkManifest(requires, versions({ time: "0.1.0" }))).toEqual({
      kind: "require",
      spec: "memory@^2",
      reason: "missing",
    })
    expect(checkManifest(requires, versions({ time: "0.1.0", memory: "1.4.0" }))).toEqual({
      kind: "require",
      spec: "memory@^2",
      reason: "version",
    })
    expect(checkManifest(requires, versions({ time: "0.1.0", memory: "2.3.0" }))).toBeUndefined()
  })

  it("treats a requirement without a range as presence only", () => {
    const manifest = { ...DEFAULT_MANIFEST, requires: ["time"] }
    expect(checkManifest(manifest, versions({ time: "9.9.9" }))).toBeUndefined()
    expect(checkManifest(manifest, versions({}))?.kind).toBe("require")
  })
})
