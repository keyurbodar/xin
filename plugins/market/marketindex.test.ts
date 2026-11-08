import { describe, expect, it } from "vitest"
import { marketInstallTarget, MarketIndexError, parseMarketIndex } from "./marketindex.ts"

const INDEX_URL = "https://index.test/xin.json"
const COMMIT = "b".repeat(40)

const version = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "1.0.0",
  publishTimestamp: 1_767_225_600,
  source: { type: "npm" },
  engines: {},
  ...overrides,
})

const plugin = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "@lahn/xin-notes",
  metadata: { keywords: ["notes"] },
  versions: [version()],
  ...overrides,
})

const index = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1,
  title: "Test market",
  metadata: {},
  plugins: [plugin()],
  ...overrides,
})

const parse = (value: unknown, url = INDEX_URL) => parseMarketIndex(value, url)

const rejection = (run: () => unknown): { readonly path: string; readonly reason: string } => {
  try {
    run()
  } catch (error) {
    if (error instanceof MarketIndexError) return { path: error.path, reason: error.reason }
    throw error
  }
  throw new Error("expected a MarketIndexError")
}

describe("parseMarketIndex", () => {
  it("fills absent metadata and optional members", () => {
    expect(parse(index())).toEqual({
      format: 1,
      title: "Test market",
      metadata: { categories: {}, labels: {}, sortKeys: {} },
      plugins: [
        {
          name: "@lahn/xin-notes",
          metadata: { keywords: ["notes"], labels: [], sortKeys: {} },
          versions: [{ version: "1.0.0", publishTimestamp: 1_767_225_600, source: { type: "npm" }, engines: {} }],
        },
      ],
    })
  })

  it("sorts versions newest first and keeps per-version engines and sources", () => {
    const parsed = parse(
      index({
        plugins: [
          plugin({
            versions: [
              version({ version: "1.0.0" }),
              version({
                version: "2.0.0",
                engines: { xin: ">=1.0.0" },
                source: { type: "npm", registry: "https://npm.test" },
              }),
              version({ version: "1.5.0" }),
            ],
          }),
        ],
      }),
    )
    expect(parsed.plugins[0]?.versions.map((entry) => entry.version)).toEqual(["2.0.0", "1.5.0", "1.0.0"])
    expect(parsed.plugins[0]?.versions[0]?.engines).toEqual({ xin: ">=1.0.0" })
    expect(parsed.plugins[0]?.versions[0]?.source).toEqual({ type: "npm", registry: "https://npm.test/" })
  })

  it("accepts a localized title and rejects one without en", () => {
    expect(parse(index({ title: { en: "Market", de: "Markt" } })).title).toEqual({ en: "Market", de: "Markt" })
    expect(rejection(() => parse(index({ title: { de: "Markt" } })))).toEqual({
      path: "$.title",
      reason: "must contain en",
    })
  })

  it("rejects packages instead of plugins at $.plugins", () => {
    expect(rejection(() => parse({ format: 1, title: "Market", metadata: {}, packages: [] }))).toEqual({
      path: "$.plugins",
      reason: "must be an array",
    })
  })

  it("rejects a format other than 1", () => {
    expect(rejection(() => parse(index({ format: 2 })))).toEqual({ path: "$.format", reason: "must be 1" })
  })

  it("rejects a repeated plugin name and a repeated version", () => {
    const repeatedName = rejection(() => parse(index({ plugins: [plugin(), plugin()] })))
    expect(repeatedName).toEqual({
      path: "$.plugins[1].name",
      reason: "duplicates @lahn/xin-notes",
    })
    const repeatedVersion = rejection(() => parse(index({ plugins: [plugin({ versions: [version(), version()] })] })))
    expect(repeatedVersion).toEqual({
      path: "$.plugins[0].versions[1].version",
      reason: "duplicates 1.0.0",
    })
  })

  it("rejects an empty version list, a non-exact version and a bad timestamp", () => {
    expect(rejection(() => parse(index({ plugins: [plugin({ versions: [] })] })))).toEqual({
      path: "$.plugins[0].versions",
      reason: "must be a non-empty array",
    })
    expect(
      rejection(() => parse(index({ plugins: [plugin({ versions: [version({ version: "^1.0.0" })] })] }))),
    ).toEqual({
      path: "$.plugins[0].versions[0].version",
      reason: "must be an exact SemVer version",
    })
    expect(
      rejection(() => parse(index({ plugins: [plugin({ versions: [version({ publishTimestamp: 1.5 })] })] }))),
    ).toEqual({
      path: "$.plugins[0].versions[0].publishTimestamp",
      reason: "must be an integer number of Unix seconds in [0, 10^11)",
    })
  })

  it("validates engines.xin as a range and ignores engines.dsh", () => {
    expect(() =>
      parse(index({ plugins: [plugin({ versions: [version({ engines: { xin: ">=1.0.0" } })] })] })),
    ).not.toThrow()
    expect(() =>
      parse(index({ plugins: [plugin({ versions: [version({ engines: { dsh: ">=1.0.0" } })] })] })),
    ).not.toThrow()
    expect(
      rejection(() =>
        parse(index({ plugins: [plugin({ versions: [version({ engines: { xin: "workspace:*" } })] })] })),
      ),
    ).toEqual({
      path: "$.plugins[0].versions[0].engines.xin",
      reason: "must not be a workspace: range",
    })
    expect(
      rejection(() => parse(index({ plugins: [plugin({ versions: [version({ engines: { xin: "latest" } })] })] }))),
    ).toEqual({
      path: "$.plugins[0].versions[0].engines.xin",
      reason: "must be a SemVer range",
    })
  })

  it("validates a git source and builds the install spec", () => {
    const parsed = parse(
      index({
        plugins: [
          plugin({
            versions: [
              version({
                source: {
                  type: "git",
                  url: "https://github.com/lahn/xin-tools",
                  commit: COMMIT,
                  path: "packages/tools",
                },
              }),
            ],
          }),
        ],
      }),
    )
    const listed = parsed.plugins[0]?.versions[0]
    expect(listed?.source).toEqual({
      type: "git",
      url: "https://github.com/lahn/xin-tools",
      commit: COMMIT,
      path: "packages/tools",
    })
    expect(listed === undefined ? undefined : marketInstallTarget("@lahn/xin-tools", listed)).toEqual({
      spec: `git+https://github.com/lahn/xin-tools.git#${COMMIT}&path:/packages/tools`,
    })
  })

  it("rejects a git commit that is not 40 lowercase hex digits", () => {
    expect(
      rejection(() =>
        parse(
          index({
            plugins: [
              plugin({
                versions: [version({ source: { type: "git", url: "https://github.com/lahn/x", commit: "ABC" } })],
              }),
            ],
          }),
        ),
      ),
    ).toEqual({ path: "$.plugins[0].versions[0].source.commit", reason: "must be a lowercase 40-hex-digit commit SHA" })
  })

  it("builds name@version for an npm source and resolves a relative icon", () => {
    const parsed = parse(index({ plugins: [plugin({ icon: "icons/notes.png" })] }))
    const listed = parsed.plugins[0]?.versions[0]
    expect(listed === undefined ? undefined : marketInstallTarget("@lahn/xin-notes", listed)).toEqual({
      spec: "@lahn/xin-notes@1.0.0",
    })
    expect(parsed.plugins[0]?.icon).toBe("https://index.test/icons/notes.png")
  })

  it("rejects a data icon over 32 KiB and an icon on another plain-http origin", () => {
    const payload = "A".repeat(43692)
    expect(rejection(() => parse(index({ plugins: [plugin({ icon: `data:image/png;base64,${payload}` })] })))).toEqual({
      path: "$.plugins[0].icon",
      reason: "must not exceed 32 KiB of decoded bytes",
    })
    expect(rejection(() => parse(index({ plugins: [plugin({ icon: "http://evil.test/x.png" })] })))).toEqual({
      path: "$.plugins[0].icon",
      reason: "must resolve to https or the index origin",
    })
  })

  it("requires the index url to be absolute", () => {
    expect(rejection(() => parse(index(), "not a url")).path).toBe("$")
  })
})
