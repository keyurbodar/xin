import { runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { integrityOf, tarball } from "../../test/plugins/market.ts"
import { cmd, field, fresh, type Ack, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const REGISTRY = "https://registry.npmjs.org"
const REGISTRY_HOST = "registry.npmjs.org"
const INDEX_URL = "https://index.test/xin.json"
const BAD_INDEX_URL = "https://index.test/bad.json"

const NOTES = "@lahn/xin-notes"
const TOOLS = "@lahn/xin-tools"
const CODE = "@lahn/xin-code"
const BROKEN = "@lahn/xin-broken"
const FUTURE = "@lahn/xin-future"
const FLAKY = "@lahn/xin-flaky"
const PROVIDED = "xin-plugin-time"
const PATCHY = "@lahn/xin-patchy"
const COMMIT = "a".repeat(40)
const GIT_PATH = "packages/tools"
const GIT_SPEC = `git+https://github.com/lahn/xin-tools.git#${COMMIT}&path:/${GIT_PATH}`

type SeedSource =
  | {
      readonly type: "npm"
    }
  | { readonly type: "git"; readonly url: string; readonly commit: string; readonly path?: string }

type SeedVersion = {
  readonly version: string
  readonly source?: SeedSource
  readonly engines?: { readonly xin?: string }
  readonly xin?: unknown
  readonly tarballXin?: unknown
  readonly integrity?: string
}

type Seed = {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly author?: string
  readonly category?: string
  readonly repository?: { readonly url: string }
  readonly versions: readonly SeedVersion[]
}

type Doc = {
  readonly name: string
  readonly version: string
  readonly xin?: unknown
  readonly dist: { readonly tarball: string; readonly integrity: string }
}

type Built = SeedVersion & {
  readonly doc: Doc | undefined
  readonly tarballUrl: string
  readonly bytes: Uint8Array
  readonly integrity: string
}

type Fake = {
  readonly urls: string[]
  readonly fetch: typeof fetch
}

const notes = (timezone: string, extra: readonly { id: string; timezone: string }[] = []): unknown => ({
  bundle: [
    { id: "market-time", plugin: "time", config: { timezone } },
    ...extra.map((row) => ({ id: row.id, plugin: "time", config: { timezone: row.timezone } })),
  ],
})

const NOTES_1_0 = notes("Asia/Tokyo")
const NOTES_1_1 = notes("Asia/Tokyo", [{ id: "market-clock", timezone: "Europe/Berlin" }])
const FLAKY_1_0 = { bundle: [{ id: "flaky-time", plugin: "time", config: { timezone: "Asia/Tokyo" } }] }
const FLAKY_1_1 = { bundle: [{ id: "flaky-bad", plugin: "time", config: { timezone: "Not/AZone" } }] }
const CODE_XIN = { plugins: { tools: { module: "./index.ts" } } }

const SEEDS: readonly Seed[] = [
  {
    name: NOTES,
    title: "Notes",
    description: "Take notes from sources.",
    author: "Lahn",
    category: "developer",
    repository: { url: "https://github.com/lahn/xin-notes" },
    versions: [
      { version: "0.9.0", xin: NOTES_1_0 },
      { version: "1.0.0", xin: NOTES_1_0 },
      { version: "1.1.0", xin: NOTES_1_1 },
    ],
  },
  {
    name: PATCHY,
    title: "Patchy",
    versions: [
      { version: "1.0.0", xin: FLAKY_1_0 },
      { version: "1.0.1", xin: FLAKY_1_0 },
    ],
  },
  {
    name: FLAKY,
    versions: [
      { version: "1.0.0", xin: FLAKY_1_0 },
      { version: "1.1.0", xin: FLAKY_1_1 },
    ],
  },
  {
    name: TOOLS,
    versions: [
      {
        version: "1.0.0",
        source: { type: "git", url: "https://github.com/lahn/xin-tools", commit: COMMIT, path: GIT_PATH },
      },
    ],
  },
  {
    name: CODE,
    versions: [
      { version: "1.0.0", xin: CODE_XIN },
      { version: "1.1.0", xin: CODE_XIN },
    ],
  },
  {
    name: BROKEN,
    versions: [
      {
        version: "1.0.0",
        xin: NOTES_1_0,
        integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      },
    ],
  },
  {
    name: FUTURE,
    versions: [{ version: "2.0.0", xin: NOTES_1_0, engines: { xin: ">=99.0.0" } }],
  },
  {
    name: PROVIDED,
    title: "Current time",
    versions: [{ version: "0.2.0", xin: NOTES_1_0 }],
  },
]

async function build(seed: Seed): Promise<readonly Built[]> {
  return Promise.all(
    seed.versions.map(async (version) => {
      if (version.source?.type === "git")
        return {
          ...version,
          doc: undefined,
          tarballUrl: "",
          bytes: new Uint8Array(),
          integrity: "",
        }
      const bytes = await tarball({
        "package.json": JSON.stringify({
          name: seed.name,
          version: version.version,
          xin: version.tarballXin ?? version.xin,
        }),
      })
      const integrity = version.integrity ?? (await integrityOf(bytes))
      const tarballUrl = `${REGISTRY}/${seed.name}/-/${version.version}.tgz`
      return {
        ...version,
        tarballUrl,
        bytes,
        integrity,
        doc: {
          name: seed.name,
          version: version.version,
          ...(version.xin === undefined ? {} : { xin: version.xin }),
          dist: { tarball: tarballUrl, integrity },
        },
      }
    }),
  )
}

const BUILT = await Promise.all(SEEDS.map(build))

const INDEX_DOCUMENT = {
  format: 1,
  title: "Xin test market",
  description: "Fixtures for the market proof.",
  metadata: { categories: { developer: { title: "Developer tools" } }, labels: {}, sortKeys: {} },
  plugins: SEEDS.map((seed, position) => ({
    name: seed.name,
    ...(seed.title === undefined ? {} : { title: seed.title }),
    ...(seed.description === undefined ? {} : { description: seed.description }),
    ...(seed.author === undefined ? {} : { author: seed.author }),
    ...(seed.repository === undefined ? {} : { repository: seed.repository }),
    metadata: {
      ...(seed.category === undefined ? {} : { category: seed.category }),
      keywords: [],
      labels: [],
      sortKeys: {},
    },
    versions: (BUILT[position] ?? []).map((version) => ({
      version: version.version,
      publishTimestamp: 1_767_225_600,
      source: version.source ?? { type: "npm" },
      engines: version.engines ?? {},
    })),
  })),
}

const JSON_HEADERS = { "content-type": "application/json" }
const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: JSON_HEADERS })

function fake(): Fake {
  const urls: string[] = []
  const documents = new Map<string, unknown>()
  const tarballs = new Map<string, Uint8Array>()
  for (const built of BUILT.flat()) {
    if (built.doc === undefined) continue
    documents.set(`${built.doc.name}/${built.doc.version}`, built.doc)
    tarballs.set(built.tarballUrl, built.bytes)
  }
  const handler: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    urls.push(url.href)
    if (url.host === "index.test") {
      return url.pathname === "/bad.json"
        ? json({ format: 1, title: "Bad", metadata: {}, packages: [] })
        : json(INDEX_DOCUMENT)
    }
    if (url.host !== REGISTRY_HOST) return new Response("not found", { status: 404 })
    const bytes = tarballs.get(url.href)
    if (bytes !== undefined) return new Response(bytes, { status: 200 })
    const document = documents.get(decodeURIComponent(url.pathname.slice(1)))
    return document === undefined ? new Response("not found", { status: 404 }) : json(document)
  }
  return { urls, fetch: handler }
}

const serve = (transport: Fake): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(transport.fetch)
}

const configure = (stub: Stub, config: unknown): Promise<unknown> =>
  cmd(stub, `market-config-${crypto.randomUUID()}`, "plugin.configure", { id: "market", config })

const op = (stub: Stub, name: string, args: unknown = {}): Promise<Ack> =>
  cmd(stub, `market-${name}-${crypto.randomUUID()}`, name, args)

const pending = async (stub: Stub): Promise<unknown> => {
  const ack = await op(stub, "plugin.packages")
  return field(ack.result, "pending")
}

const entriesOf = (ack: Ack): readonly unknown[] => {
  const found = field(ack.result, "entries")
  return Array.isArray(found) ? found : []
}

const indexHits = (transport: Fake): number =>
  transport.urls.filter((url) => url.startsWith("https://index.test/")).length

const installedClock = (stub: Stub, row: string): Promise<boolean> =>
  runInDurableObject(stub, (home: Home) => {
    try {
      home.extension(`clock-${row}`)
      return true
    } catch {
      return false
    }
  })

afterEach(() => vi.restoreAllMocks())

describe("market", () => {
  it("browses the build's own packages with no index configured and no request", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()

    const listed = await op(stub, "market.search")
    expect(entriesOf(listed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "xin-plugin-presets",
          title: "Presets",
          category: "first-party",
          status: "provided",
        }),
        expect.objectContaining({ name: "xin-plugin-memory", status: "provided" }),
      ]),
    )
    expect(transport.urls).toEqual([])

    const entry = await op(stub, "market.entry", { name: "xin-plugin-presets" })
    expect(entry.result, JSON.stringify(entry)).toMatchObject({
      name: "xin-plugin-presets",
      kind: "code",
      status: "provided",
    })
    expect(field(entry.result, "rows")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preset-full",
          plugin: "preset",
          config: { id: "full", name: "Full", description: "Every plugin.", plugins: "all" },
        }),
        expect.objectContaining({
          id: "preset-minimal",
          plugin: "preset",
          config: {
            id: "minimal",
            name: "Minimal",
            description: "Memory and skills only.",
            plugins: ["tool-memory", "tool-skills"],
          },
        }),
      ]),
    )
    expect(transport.urls).toEqual([])
  })

  it("reads dsh format-1 indexes and skips a malformed one with its path", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL, BAD_INDEX_URL] })).toMatchObject({ ok: true })

    expect((await op(stub, "market.refresh")).result).toEqual({
      indexes: [
        { url: INDEX_URL, title: "Xin test market", description: "Fixtures for the market proof." },
        { url: BAD_INDEX_URL, error: "$.plugins must be an array" },
      ],
    })

    const found = await op(stub, "market.search", { category: "developer" })
    expect(field(found.result, "entries")).toMatchObject([
      {
        name: NOTES,
        title: "Notes",
        description: "Take notes from sources.",
        author: "Lahn",
        category: "developer",
        status: "not-installed",
      },
    ])

    const byQuery = await op(stub, "market.search", { query: "take notes" })
    expect(entriesOf(byQuery).map((entry) => field(entry, "name"))).toEqual([NOTES])

    const provided = await op(stub, "market.search", { query: "current time" })
    expect(field(provided.result, "entries")).toMatchObject([{ name: PROVIDED, status: "provided" }])
  })

  it("installs 1.0.0, shows update-available, mounts 1.1.0 live and restores a failed update", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })

    expect(await op(stub, "market.install", { name: NOTES, version: "1.0.0" })).toMatchObject({
      ok: true,
      result: { application: "applied", package: NOTES, version: "1.0.0", kind: "bundle" },
    })
    expect((await op(stub, "bundle.list")).result).toMatchObject([
      {
        package: NOTES,
        source: { kind: "registry", version: "1.0.0" },
        rows: [{ state: { kind: "active" } }],
      },
    ])

    expect(await installedClock(stub, "market-time")).toBe(true)

    expect((await op(stub, "market.entry", { name: NOTES })).result).toMatchObject({
      kind: "bundle",
      status: "update-available",
      readme: null,
      versions: [
        { version: "1.1.0", compatible: true },
        { version: "1.0.0", compatible: true },
        { version: "0.9.0", compatible: true },
      ],
    })

    expect(await op(stub, "market.update", { name: NOTES, version: "1.1.0" })).toMatchObject({
      ok: true,
      result: { application: "applied", version: "1.1.0" },
    })
    expect(await installedClock(stub, "market-time")).toBe(true)
    expect(await installedClock(stub, "market-clock")).toBe(true)

    expect(await op(stub, "market.update", { name: NOTES, version: "0.9.0" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("not newer") },
    })

    expect(await op(stub, "market.install", { name: FLAKY, version: "1.0.0" })).toMatchObject({
      ok: true,
      result: { application: "applied", version: "1.0.0" },
    })
    const failed = await op(stub, "market.update", { name: FLAKY, version: "1.1.0" })
    expect(failed).toMatchObject({ ok: true, result: { application: "failed" } })
    expect(field(failed.result, "rows")).toEqual(
      expect.arrayContaining([expect.objectContaining({ error: expect.any(String) })]),
    )
    expect((await op(stub, "bundle.list")).result).toMatchObject([
      { package: NOTES, source: { kind: "registry", version: "1.1.0" } },
      { package: FLAKY, source: { kind: "registry", version: "1.0.0" } },
    ])
    expect(await installedClock(stub, "market-time")).toBe(true)
    expect(await installedClock(stub, "market-clock")).toBe(true)
    expect(await installedClock(stub, "flaky-time")).toBe(true)
    expect(await installedClock(stub, "flaky-bad")).toBe(false)
  })

  it("records a git version and a code package as pending installs", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })

    expect(await op(stub, "market.install", { name: TOOLS })).toMatchObject({
      ok: true,
      result: { application: "pending", package: TOOLS, version: "1.0.0", kind: "code" },
    })
    expect(await pending(stub)).toEqual({ add: [GIT_SPEC], remove: [] })
    expect((await op(stub, "market.entry", { name: TOOLS })).result).toMatchObject({ status: "installed" })
    expect(await op(stub, "market.install", { name: TOOLS })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("already installed") },
    })

    expect(await op(stub, "market.install", { name: CODE, version: "1.0.0" })).toMatchObject({
      ok: true,
      result: { application: "pending", package: CODE, version: "1.0.0", kind: "code" },
    })
    expect(await pending(stub)).toEqual({ add: [GIT_SPEC, `${CODE}@1.0.0`], remove: [] })

    expect(await op(stub, "market.update", { name: CODE, version: "1.1.0" })).toMatchObject({
      ok: true,
      result: { application: "pending", version: "1.1.0" },
    })
    expect(await pending(stub)).toEqual({ add: [GIT_SPEC, `${CODE}@1.1.0`], remove: [] })
  })

  it("refuses provided, already installed and incompatible packages and a wrong integrity", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })

    expect(await op(stub, "market.install", { name: PROVIDED })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("provided") },
    })
    expect(await op(stub, "market.install", { name: FUTURE })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("requires xin") },
    })
    expect((await op(stub, "market.entry", { name: FUTURE })).result).toMatchObject({
      status: "not-installed",
      versions: [{ version: "2.0.0", compatible: false }],
    })
    expect(await op(stub, "market.install", { name: BROKEN })).toMatchObject({
      ok: false,
      error: { code: "failed", message: expect.stringContaining("integrity") },
    })
    expect((await op(stub, "bundle.list")).result).toEqual([])

    expect((await op(stub, "market.install", { name: NOTES })).ok).toBe(true)
    expect(await op(stub, "market.install", { name: NOTES })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("already installed") },
    })
  })

  it("caches a read index for the configured ttl and market.refresh bypasses it", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL], cacheTtlMs: 60_000 })).toMatchObject({ ok: true })
    transport.urls.length = 0

    expect((await op(stub, "market.search")).ok).toBe(true)
    expect(indexHits(transport)).toBe(1)
    expect((await op(stub, "market.search")).ok).toBe(true)
    expect(indexHits(transport)).toBe(1)

    expect((await op(stub, "market.refresh")).ok).toBe(true)
    expect(indexHits(transport)).toBe(2)
  })

  it("keeps the update policy in kv, off by default", async () => {
    const stub = fresh()
    expect(await configure(stub, {})).toMatchObject({ ok: true })

    expect((await op(stub, "market.policy")).result).toEqual({ autoUpdate: false })
    expect(await op(stub, "market.policy.set", { autoUpdate: true })).toMatchObject({
      ok: true,
      result: { autoUpdate: true },
    })
    expect((await op(stub, "market.policy")).result).toEqual({ autoUpdate: true })
    expect(await op(stub, "market.policy.set", { autoUpdate: "yes" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
  })

  it("applies patch updates on refresh while auto-update is on, and a minor bump still asks", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })
    expect(await op(stub, "market.install", { name: PATCHY, version: "1.0.0" })).toMatchObject({ ok: true })
    expect(await op(stub, "market.install", { name: NOTES, version: "1.0.0" })).toMatchObject({ ok: true })

    expect((await op(stub, "market.refresh")).result).not.toHaveProperty("applied")
    expect(await op(stub, "market.policy.set", { autoUpdate: true })).toMatchObject({ ok: true })
    expect((await op(stub, "market.refresh")).result).toMatchObject({
      applied: [{ application: "applied", package: PATCHY, version: "1.0.1", kind: "bundle" }],
    })
    const listed = (await op(stub, "bundle.list")).result
    const installed = new Map(
      (Array.isArray(listed) ? listed : []).map(
        (entry) => [field(entry, "package"), field(field(entry, "source"), "version")] as const,
      ),
    )
    expect(installed.get(PATCHY)).toBe("1.0.1")
    expect(installed.get(NOTES)).toBe("1.0.0")
  })

  it("skips an offered version, marks it, and frees it on unskip", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })
    expect(await op(stub, "market.install", { name: NOTES, version: "1.0.0" })).toMatchObject({ ok: true })

    expect(await op(stub, "market.skip", { name: NOTES })).toMatchObject({
      ok: true,
      result: { name: NOTES, version: "1.1.0" },
    })
    expect((await op(stub, "market.skipped")).result).toEqual([{ name: NOTES, version: "1.1.0" }])
    expect(await op(stub, "market.update", { name: NOTES, version: "1.1.0" })).toMatchObject({
      ok: true,
      result: { application: "skipped", package: NOTES, version: "1.1.0" },
    })
    expect((await op(stub, "market.entry", { name: NOTES })).result).toMatchObject({
      versions: [
        { version: "1.1.0", skipped: true },
        { version: "1.0.0", skipped: false },
        { version: "0.9.0", skipped: false },
      ],
    })
    expect(entriesOf(await op(stub, "market.search", { query: "take notes" }))).toMatchObject([
      { name: NOTES, skipped: true },
    ])
    expect((await op(stub, "bundle.list")).result).toMatchObject([
      { package: NOTES, source: { kind: "registry", version: "1.0.0" } },
    ])

    expect(await op(stub, "market.unskip", { name: NOTES })).toMatchObject({ ok: true, result: { name: NOTES } })
    expect((await op(stub, "market.skipped")).result).toEqual([])
    expect(await op(stub, "market.update", { name: NOTES, version: "1.1.0" })).toMatchObject({
      ok: true,
      result: { application: "applied", version: "1.1.0" },
    })
  })

  it("rolls back to the version installed before the current one", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })
    expect(await op(stub, "market.install", { name: NOTES, version: "1.0.0" })).toMatchObject({ ok: true })
    expect(await op(stub, "market.update", { name: NOTES, version: "1.1.0" })).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await installedClock(stub, "market-clock")).toBe(true)

    expect(await op(stub, "market.rollback", { name: NOTES })).toMatchObject({
      ok: true,
      result: { application: "applied", package: NOTES, version: "1.0.0", kind: "bundle", rows: [] },
    })
    expect((await op(stub, "bundle.list")).result).toMatchObject([
      { package: NOTES, source: { kind: "registry", version: "1.0.0" } },
    ])
    expect(await installedClock(stub, "market-time")).toBe(true)
    expect(await installedClock(stub, "market-clock")).toBe(false)

    expect((await op(stub, "market.rollback", { name: NOTES })).result).toEqual({
      application: "failed",
      package: NOTES,
      reason: "no earlier version",
    })
  })

  it("answers failed when no earlier version is recorded and refuses an unknown package", async () => {
    const transport = fake()
    serve(transport)
    const stub = fresh()
    expect(await configure(stub, { indexes: [INDEX_URL] })).toMatchObject({ ok: true })
    expect(await op(stub, "market.install", { name: FLAKY, version: "1.0.0" })).toMatchObject({ ok: true })

    expect((await op(stub, "market.rollback", { name: FLAKY })).result).toEqual({
      application: "failed",
      package: FLAKY,
      reason: "no earlier version",
    })
    expect(await op(stub, "market.rollback", { name: "@lahn/xin-missing" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("not in any market index") },
    })
  })
})
