import { describe, expect, it } from "vitest"
import { kindOf, newestCompatible, offeredVersion, status, type StatusInput } from "./select.ts"

const XIN = "0.1.0"

const version = (text: string, options: { deprecated?: string; xin?: string; dist?: string } = {}) => ({
  version: text,
  ...(options.deprecated === undefined ? {} : { deprecated: options.deprecated }),
  ...(options.xin === undefined ? {} : { engines: { xin: options.xin } }),
  ...(options.dist === undefined ? {} : { dist: { tarball: options.dist } }),
})

const facts = (input: Partial<StatusInput> = {}): StatusInput => ({ versions: [], xinVersion: XIN, ...input })

describe("kindOf", () => {
  it("reads a bundle declaration", () => {
    expect(kindOf({ bundle: [{ id: "prompt", plugin: "prompt" }] })).toBe("bundle")
  })

  it("reads a code declaration", () => {
    expect(kindOf({ plugins: { market: { module: "./index.ts" } } })).toBe("code")
  })

  it("treats a package that declares both as code", () => {
    expect(kindOf({ bundle: [], plugins: {} })).toBe("code")
  })

  it("rejects a package that declares neither", () => {
    expect(kindOf({})).toBeUndefined()
    expect(kindOf(undefined)).toBeUndefined()
    expect(kindOf("bundle")).toBeUndefined()
  })
})

describe("newestCompatible", () => {
  it("picks the newest stable version", () => {
    const found = newestCompatible([version("1.0.0"), version("1.10.0"), version("1.2.0")], XIN)
    expect(found?.version).toBe("1.10.0")
  })

  it("skips prereleases when a stable version exists", () => {
    const found = newestCompatible([version("1.0.0"), version("2.0.0-beta.1"), version("1.5.0-rc.2")], XIN)
    expect(found?.version).toBe("1.0.0")
  })

  it("falls back to prereleases when no stable version exists", () => {
    const found = newestCompatible([version("2.0.0-beta.1"), version("2.0.0-beta.2"), version("1.0.0-rc.1")], XIN)
    expect(found?.version).toBe("2.0.0-beta.2")
  })

  it("skips deprecated versions", () => {
    const found = newestCompatible([version("1.0.0"), version("1.1.0", { deprecated: "use 2" })], XIN)
    expect(found?.version).toBe("1.0.0")
  })

  it("skips versions whose engines.xin is not satisfied", () => {
    const found = newestCompatible([version("1.0.0"), version("2.0.0", { xin: ">=0.2.0" })], XIN)
    expect(found?.version).toBe("1.0.0")
  })

  it("accepts versions without engines.xin or with a satisfied range", () => {
    const found = newestCompatible([version("1.0.0"), version("1.1.0", { xin: ">=0.1.0" })], XIN)
    expect(found?.version).toBe("1.1.0")
  })

  it("returns the whole version fact, not just the version", () => {
    const found = newestCompatible([version("1.0.0", { dist: "https://example.com/a.tgz" })], XIN)
    expect(found).toMatchObject({ version: "1.0.0", dist: { tarball: "https://example.com/a.tgz" } })
  })

  it("returns nothing when every version is incompatible", () => {
    expect(newestCompatible([version("1.0.0", { xin: ">=99.0.0" })], XIN)).toBeUndefined()
    expect(newestCompatible([], XIN)).toBeUndefined()
  })
})

describe("offeredVersion", () => {
  it("offers the latest tag when it is compatible and not deprecated", () => {
    const found = offeredVersion([version("1.0.0"), version("2.0.0"), version("1.1.0")], { latest: "1.1.0" }, XIN)
    expect(found?.version).toBe("1.1.0")
  })

  it("falls back to the newest compatible version when the latest tag is incompatible", () => {
    const found = offeredVersion([version("1.0.0"), version("2.0.0", { xin: ">=99.0.0" })], { latest: "2.0.0" }, XIN)
    expect(found?.version).toBe("1.0.0")
  })

  it("falls back when the latest tag is deprecated", () => {
    const found = offeredVersion(
      [version("1.0.0"), version("1.1.0", { deprecated: "use 2" })],
      { latest: "1.1.0" },
      XIN,
    )
    expect(found?.version).toBe("1.0.0")
  })
})

describe("status", () => {
  it("reports a local package first", () => {
    expect(status(facts({ local: true, versions: [version("1.0.0")] }))).toBe("local")
  })

  it("reports a waiting build", () => {
    expect(status(facts({ pending: "2.0.0", versions: [version("1.0.0")] }))).toBe("pending")
    expect(status(facts({ pending: "1.0.0", installed: { version: "0.9.0" }, versions: [version("1.0.0")] }))).toBe(
      "pending",
    )
  })

  it("reports incompatible when no version satisfies engines.xin", () => {
    expect(status(facts({ versions: [version("1.0.0", { xin: ">=99.0.0" })] }))).toBe("incompatible")
    expect(status(facts({ installed: { version: "0.1.0" }, versions: [] }))).toBe("incompatible")
  })

  it("reports available when it is not installed", () => {
    expect(status(facts({ versions: [version("1.0.0")] }))).toBe("available")
  })

  it("reports installed at the newest compatible version", () => {
    expect(status(facts({ installed: { version: "1.1.0" }, versions: [version("1.1.0"), version("1.0.0")] }))).toBe(
      "installed",
    )
  })

  it("reports update when a newer compatible version exists", () => {
    expect(status(facts({ installed: { version: "1.0.0" }, versions: [version("1.1.0"), version("1.0.0")] }))).toBe(
      "update",
    )
  })

  it("reports installed when a newer version exists but is incompatible", () => {
    expect(
      status(
        facts({
          installed: { version: "1.0.0" },
          versions: [version("1.0.0"), version("2.0.0", { xin: ">=9" })],
        }),
      ),
    ).toBe("installed")
  })
})
