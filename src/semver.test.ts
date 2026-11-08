import { describe, expect, it } from "vitest"
import { compareVersions, isPrerelease, satisfies } from "./semver.ts"

describe("satisfies", () => {
  it("accepts a caret range", () => {
    expect(satisfies("0.1.0", "^0.1.0")).toBe(true)
    expect(satisfies("0.1.5", "^0.1.0")).toBe(true)
    expect(satisfies("0.2.0", "^0.1.0")).toBe(false)
    expect(satisfies("1.2.3", "^1.2.0")).toBe(true)
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false)
  })

  it("accepts a tilde range", () => {
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true)
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false)
  })

  it("accepts comparison ranges and alternatives", () => {
    expect(satisfies("1.0.0", ">=0.1.0")).toBe(true)
    expect(satisfies("0.0.9", ">=0.1.0")).toBe(false)
    expect(satisfies("3.0.0", "<2.0.0 || >=3.0.0")).toBe(true)
  })

  it("rejects an unparseable version or range", () => {
    expect(satisfies("latest", ">=0.1.0")).toBe(false)
    expect(satisfies("1.0.0", "not-a-range")).toBe(false)
  })
})

describe("compareVersions", () => {
  it("orders numeric parts numerically", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0)
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
  })

  it("orders prereleases below the release", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0)
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0)
  })

  it("orders prerelease identifiers by the semver rules", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0)
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta")).toBeLessThan(0)
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBeLessThan(0)
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0)
  })

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0)
  })
})

describe("isPrerelease", () => {
  it("detects a prerelease", () => {
    expect(isPrerelease("1.0.0-rc.1")).toBe(true)
    expect(isPrerelease("2.0.0-beta")).toBe(true)
  })

  it("ignores releases and build metadata", () => {
    expect(isPrerelease("1.0.0")).toBe(false)
    expect(isPrerelease("1.0.0+build.5")).toBe(false)
  })
})
