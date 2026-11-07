import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, field, fresh, recordOffers, turn, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { integrityOf, tarball } from "../../test/plugins/market.ts"

const REGISTRY = "https://registry.npmjs.org"
const REGISTRY_HOST = "registry.npmjs.org"
const INDEX_URL = "https://index.test/xin.json"
const INDEX_URLS = Array.from({ length: 8 }, (_, index) => `https://index.test/xin-${index}.json`)

const NOTES = "@lahn/xin-notes"
const QUIET = "@lahn/xin-quiet"
const TOOLS = "@lahn/xin-tools"
const FUTURE = "@lahn/xin-future"
const MIXED = "@lahn/xin-mixed"
const BROKEN = "@lahn/xin-broken"

type VersionSeed = {
  readonly version: string
  readonly xin?: unknown
  readonly tarballXin?: unknown
  readonly files?: Readonly<Record<string, string>>
  readonly readme?: string
  readonly engines?: { readonly xin: string }
  readonly deprecated?: string
  readonly integrity?: string
  readonly publishedAt?: string
  readonly tarballUrl?: string
}

type Built = {
  readonly version: string
  readonly xin: unknown
  readonly readme: string | undefined
  readonly engines: { readonly xin: string } | undefined
  readonly deprecated: string | undefined
  readonly tarball: string
  readonly integrity: string
  readonly bytes: Uint8Array
  readonly publishedAt: string
}

type SeedPackage = {
  readonly name: string
  readonly description?: string
  readonly searchHit?: boolean
  readonly latestTag?: string
  readonly index?: {
    readonly title?: string
    readonly description?: string
    readonly icon?: string
    readonly author?: string
    readonly repository?: string
    readonly categories?: readonly string[]
  }
  readonly versions: readonly VersionSeed[]
}

type FakePackage = {
  readonly name: string
  readonly description: string | undefined
  readonly searchHit: boolean
  readonly latestTag: string | undefined
  readonly index:
    | {
        readonly title?: string
        readonly description?: string
        readonly icon?: string
        readonly author?: string
        readonly repository?: string
        readonly categories?: readonly string[]
      }
    | undefined
  readonly versions: Built[]
}

type FakeRegistry = {
  readonly packages: Map<string, FakePackage>
  readonly urls: string[]
  readonly fetch: typeof fetch
  publish(name: string, seed: VersionSeed): Promise<void>
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })

const tarballUrl = (name: string, version: string): string => `${REGISTRY}/${name}/-/${version}.tgz`

async function build(name: string, seed: VersionSeed): Promise<Built> {
  const manifestXin = seed.tarballXin ?? seed.xin
  const bytes = await tarball({
    "package.json": JSON.stringify({
      name,
      version: seed.version,
      ...(manifestXin === undefined ? {} : { xin: manifestXin }),
    }),
    ...seed.files,
  })
  return {
    version: seed.version,
    xin: seed.xin,
    readme: seed.readme,
    engines: seed.engines,
    deprecated: seed.deprecated,
    tarball: seed.tarballUrl ?? tarballUrl(name, seed.version),
    integrity: seed.integrity ?? (await integrityOf(bytes)),
    bytes,
    publishedAt: seed.publishedAt ?? "2026-01-01T00:00:00.000Z",
  }
}

function abbreviated(pkg: FakePackage): unknown {
  const latest = pkg.latestTag ?? pkg.versions.at(-1)?.version ?? "0.0.0"
  return {
    name: pkg.name,
    "dist-tags": { latest },
    versions: Object.fromEntries(
      pkg.versions.map((built) => [
        built.version,
        {
          ...(built.deprecated === undefined ? {} : { deprecated: built.deprecated }),
          ...(built.engines === undefined ? {} : { engines: built.engines }),
          dist: { tarball: built.tarball, integrity: built.integrity },
        },
      ]),
    ),
    time: Object.fromEntries(pkg.versions.map((built) => [built.version, built.publishedAt])),
  }
}

function versionDocument(pkg: FakePackage, built: Built): unknown {
  return {
    name: pkg.name,
    version: built.version,
    ...(built.xin === undefined ? {} : { xin: built.xin }),
    ...(built.readme === undefined ? {} : { readme: built.readme }),
    ...(built.deprecated === undefined ? {} : { deprecated: built.deprecated }),
    ...(built.engines === undefined ? {} : { engines: built.engines }),
    dist: { tarball: built.tarball, integrity: built.integrity },
  }
}

async function fakeRegistry(seeds: readonly SeedPackage[]): Promise<FakeRegistry> {
  const packages = new Map<string, FakePackage>()
  const fake: FakeRegistry = {
    packages,
    urls: [],
    fetch: handler,
    async publish(name, seed) {
      const pkg = packages.get(name)
      if (pkg === undefined) throw new Error(`${name} is not in the fake registry`)
      pkg.versions.push(await build(name, seed))
    },
  }

  for (const seed of seeds) {
    const versions: Built[] = []
    for (const version of seed.versions) versions.push(await build(seed.name, version))
    packages.set(seed.name, {
      name: seed.name,
      description: seed.description,
      searchHit: seed.searchHit === true,
      latestTag: seed.latestTag,
      index: seed.index,
      versions,
    })
  }

  async function handler(input: Parameters<typeof fetch>[0]): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input))
    fake.urls.push(url.href)
    if (url.host === "index.test") {
      const entries = [...packages.values()].flatMap((pkg) =>
        pkg.index === undefined ? [] : [{ name: pkg.name, ...pkg.index }],
      )
      return json({ format: 1, packages: entries })
    }
    if (url.host !== REGISTRY_HOST) return new Response("not found", { status: 404 })
    if (url.pathname === "/-/v1/search") {
      const objects = [...packages.values()]
        .filter((pkg) => pkg.searchHit)
        .map((pkg) => ({
          package: {
            name: pkg.name,
            version: pkg.versions.at(-1)?.version ?? "0.0.0",
            ...(pkg.description === undefined ? {} : { description: pkg.description }),
          },
        }))
      return json({ objects })
    }
    const path = decodeURIComponent(url.pathname.slice(1))
    for (const pkg of packages.values()) {
      const served = pkg.versions.find((built) => built.tarball === url.href)
      if (served !== undefined) return new Response(served.bytes, { status: 200 })
      if (path === pkg.name) return json(abbreviated(pkg))
      if (path.startsWith(`${pkg.name}/`)) {
        const version = path.slice(pkg.name.length + 1)
        const built = pkg.versions.find((candidate) => candidate.version === version)
        return built === undefined ? new Response("not found", { status: 404 }) : json(versionDocument(pkg, built))
      }
    }
    return new Response("not found", { status: 404 })
  }

  return fake
}

const serve = (fake: FakeRegistry): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch)
}

const makeCheckDue = (stub: Stub): Promise<void> =>
  runInDurableObject(stub, async (home: Home) => {
    await home.db.run(
      "INSERT INTO market_checks (id, checked_at) VALUES ('last', 0) " +
        "ON CONFLICT (id) DO UPDATE SET checked_at = 0",
    )
  })

const configure = (stub: Stub, config: unknown): Promise<unknown> =>
  cmd(stub, `market-config-${crypto.randomUUID()}`, "plugin.configure", { id: "market", config })

const entries = async (stub: Stub, args: unknown): Promise<unknown[]> => {
  const ack = await cmd(stub, `market-search-${crypto.randomUUID()}`, "market.search", args)
  const found = field(ack.result, "entries")
  if (!Array.isArray(found)) throw new Error("market.search returned no entries")
  return found
}

const skillLine = (offers: ReturnType<typeof recordOffers>, line: string): void => {
  expect(offers.latest().system).toContain(line)
}

const notesSkill = (description: string, body: string): string =>
  `---\nname: notes\ndescription: ${description}\n---\n${body}`

const notesXin = (prompt: string): unknown => ({
  bundle: [
    { id: "style", plugin: "prompt", config: { title: "Notes style", text: prompt } },
    { id: "notes", plugin: "skill", config: { markdown: { $file: "skills/notes.md" } } },
  ],
})

const promptXin = (text: string): unknown => ({
  bundle: [{ id: "style", plugin: "prompt", config: { title: "Notes style", text } }],
})

const codeXin = (title: string): unknown => ({
  plugins: { tools: { module: "./index.ts", title, description: `${title} tools.` } },
})

afterEach(() => vi.restoreAllMocks())

describe("market", () => {
  it("merges an index entry and an npm search hit with status and kind", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        description: "search-side notes",
        searchHit: true,
        index: {
          title: "Notes",
          description: "Take notes from sources.",
          icon: "https://index.test/notes.png",
          author: "Lahn",
          repository: "https://github.com/lahn/xin-notes",
        },
        versions: [{ version: "1.0.0", xin: notesXin("PROMPT-ONE") }],
      },
      {
        name: QUIET,
        description: "A quiet code plugin.",
        searchHit: true,
        versions: [{ version: "1.0.0", xin: codeXin("Quiet") }],
      },
    ])
    serve(fake)
    const stub = fresh()
    await configure(stub, { indexes: [INDEX_URL] })

    expect(await entries(stub, {})).toEqual([
      {
        name: NOTES,
        title: "Notes",
        description: "Take notes from sources.",
        icon: "https://index.test/notes.png",
        author: "Lahn",
        repository: "https://github.com/lahn/xin-notes",
        kind: "bundle",
        status: "available",
      },
      {
        name: QUIET,
        title: null,
        description: "A quiet code plugin.",
        icon: null,
        author: null,
        repository: null,
        kind: "code",
        status: "available",
      },
    ])
    expect(fake.urls).toContain(INDEX_URL)
    expect(fake.urls.some((url) => url.includes("/-/v1/search"))).toBe(true)
  })

  it("installs a bundle live, reports an update, mounts it and rolls back", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        versions: [
          {
            version: "1.0.0",
            xin: notesXin("PROMPT-ONE"),
            files: { "skills/notes.md": notesSkill("Take notes from sources.", "BODY-ONE") },
          },
        ],
      },
    ])
    serve(fake)
    const stub = fresh()

    const installed = await cmd(stub, "notes-install", "market.install", { name: NOTES })
    expect(installed).toMatchObject({
      ok: true,
      result: { application: "applied", package: NOTES, version: "1.0.0", kind: "bundle" },
    })
    const listed = await cmd(stub, "notes-bundles", "bundle.list")
    expect(listed.result).toMatchObject([
      {
        package: NOTES,
        source: { kind: "registry", version: "1.0.0" },
        rows: [
          { id: `${NOTES}#style`, state: { kind: "active" } },
          { id: `${NOTES}#notes`, state: { kind: "active" } },
        ],
      },
    ])
    expect(JSON.stringify(listed.result)).not.toContain("$file")

    const first = recordOffers()
    respond([first.step("ok")])
    await turn(stub, "notes-turn-1")
    skillLine(first, "PROMPT-ONE")
    skillLine(first, "- notes: Take notes from sources.")

    await fake.publish(NOTES, {
      version: "1.1.0",
      xin: notesXin("PROMPT-TWO"),
      files: { "skills/notes.md": notesSkill("Take notes from sources, carefully.", "BODY-TWO") },
    })
    await makeCheckDue(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    expect((await cmd(stub, "notes-updates", "market.updates")).result).toEqual({
      checkedAt: expect.any(Number),
      updates: [{ package: NOTES, installed: "1.0.0", latest: "1.1.0" }],
    })
    const snapshot = await runInDurableObject(stub, (home: Home) => home.loader.ctx.wire.snapshot())
    expect(field(snapshot, "market")).toEqual({ updates: 1, checkedAt: expect.any(Number) })

    expect(await cmd(stub, "notes-update", "market.update", { name: NOTES })).toMatchObject({
      ok: true,
      result: { application: "applied", version: "1.1.0" },
    })
    const second = recordOffers()
    respond([second.step("ok")])
    await turn(stub, "notes-turn-2")
    skillLine(second, "PROMPT-TWO")
    skillLine(second, "- notes: Take notes from sources, carefully.")

    expect(await cmd(stub, "notes-rollback", "bundle.rollback", { package: NOTES })).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    const third = recordOffers()
    respond([third.step("ok")])
    await turn(stub, "notes-turn-3")
    skillLine(third, "PROMPT-ONE")
    skillLine(third, "- notes: Take notes from sources.")
  })

  it("records a code package update as pending for the next build", async () => {
    const fake = await fakeRegistry([
      { name: TOOLS, versions: [{ version: "1.0.0", xin: codeXin("Tools") }] },
      { name: FUTURE, versions: [{ version: "1.0.0", xin: codeXin("Future") }] },
    ])
    serve(fake)
    const stub = fresh()

    expect(await cmd(stub, "tools-install", "market.install", { name: TOOLS })).toMatchObject({
      ok: true,
      result: { application: "pending", package: TOOLS, version: "1.0.0", kind: "code" },
    })
    expect(field((await cmd(stub, "tools-pending", "plugin.packages")).result, "pending")).toEqual({
      add: [`${TOOLS}@1.0.0`],
      remove: [],
    })

    await fake.publish(TOOLS, { version: "1.1.0", xin: codeXin("Tools") })
    expect(await cmd(stub, "tools-update", "market.update", { name: TOOLS })).toMatchObject({
      ok: true,
      result: { application: "pending", version: "1.1.0" },
    })
    expect(field((await cmd(stub, "tools-pending-2", "plugin.packages")).result, "pending")).toEqual({
      add: [`${TOOLS}@1.1.0`],
      remove: [],
    })

    expect(await cmd(stub, "tools-missing", "market.update", { name: FUTURE })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("not installed") },
    })
    expect(await cmd(stub, "tools-local", "market.install", { name: "xin-plugin-skills" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("local") },
    })
  })

  it("refuses a tarball that does not match its integrity and installs nothing", async () => {
    const fake = await fakeRegistry([
      {
        name: BROKEN,
        versions: [{ version: "1.0.0", xin: notesXin("PROMPT-BAD"), integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAA==" }],
      },
    ])
    serve(fake)
    const stub = fresh()

    expect(await cmd(stub, "broken-install", "market.install", { name: BROKEN })).toMatchObject({
      ok: false,
      error: { code: "failed", message: expect.stringContaining("integrity") },
    })
    expect((await cmd(stub, "broken-list", "bundle.list")).result).toEqual([])
    expect(field((await cmd(stub, "broken-packages", "plugin.packages")).result, "bundles")).toEqual([])
    expect(field((await cmd(stub, "broken-pending", "plugin.packages")).result, "pending")).toEqual({
      add: [],
      remove: [],
    })

    expect((await cmd(stub, "broken-refresh", "market.refresh")).result).toEqual({
      checkedAt: expect.any(Number),
      updates: [],
    })
  })

  it("never offers or installs a version this Xin build cannot run", async () => {
    const fake = await fakeRegistry([
      {
        name: FUTURE,
        versions: [{ version: "2.0.0", xin: promptXin("PROMPT-FUTURE"), engines: { xin: ">=99.0.0" } }],
      },
      {
        name: MIXED,
        versions: [
          { version: "1.0.0", xin: promptXin("PROMPT-MIXED-ONE") },
          { version: "2.0.0", xin: promptXin("PROMPT-MIXED-TWO"), engines: { xin: ">=99.0.0" } },
        ],
      },
    ])
    serve(fake)
    const stub = fresh()

    expect(await cmd(stub, "future-entry", "market.entry", { name: FUTURE })).toMatchObject({
      ok: true,
      result: {
        status: "incompatible",
        versions: [{ version: "2.0.0", compatible: false }],
      },
    })
    expect(await cmd(stub, "future-install", "market.install", { name: FUTURE })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("compatible") },
    })
    expect(await cmd(stub, "future-exact", "market.install", { name: FUTURE, version: "2.0.0" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })

    expect(await cmd(stub, "mixed-install", "market.install", { name: MIXED })).toMatchObject({
      ok: true,
      result: { application: "applied", version: "1.0.0" },
    })
    expect(await cmd(stub, "future-entry-2", "market.entry", { name: MIXED })).toMatchObject({
      ok: true,
      result: { status: "installed" },
    })
  })

  it("keeps the installed bundle and the last check across an eviction", async () => {
    const fake = await fakeRegistry([{ name: NOTES, versions: [{ version: "1.0.0", xin: promptXin("PROMPT-ONE") }] }])
    serve(fake)
    const stub = fresh()
    expect((await cmd(stub, "evict-install", "market.install", { name: NOTES })).ok).toBe(true)
    await fake.publish(NOTES, { version: "1.1.0", xin: promptXin("PROMPT-TWO") })
    expect(await cmd(stub, "evict-refresh", "market.refresh")).toMatchObject({
      ok: true,
      result: { updates: [{ package: NOTES, installed: "1.0.0", latest: "1.1.0" }] },
    })

    await evictDurableObject(stub)

    expect((await cmd(stub, "evict-updates", "market.updates")).result).toEqual({
      checkedAt: expect.any(Number),
      updates: [{ package: NOTES, installed: "1.0.0", latest: "1.1.0" }],
    })
    expect((await cmd(stub, "evict-list", "bundle.list")).result).toMatchObject([
      { package: NOTES, source: { kind: "registry", version: "1.0.0" }, rows: [{ state: { kind: "active" } }] },
    ])
    const snapshot = await runInDurableObject(stub, (home: Home) => home.loader.ctx.wire.snapshot())
    expect(field(snapshot, "market")).toEqual({ updates: 1, checkedAt: expect.any(Number) })
  })

  it("keeps every search inside one 40-request budget", async () => {
    const seeds: SeedPackage[] = Array.from({ length: 24 }, (_, index) => ({
      name: `@budget/xin-${index}`,
      description: `budget plugin ${index}`,
      searchHit: true,
      index: { title: `Budget ${index}` },
      versions: [{ version: "1.0.0", xin: promptXin(`PROMPT-BUDGET-${index}`) }],
    }))
    const fake = await fakeRegistry(seeds)
    serve(fake)
    const stub = fresh()
    await configure(stub, { indexes: INDEX_URLS })
    fake.urls.length = 0

    const found = await entries(stub, {})
    expect(found.length).toBeGreaterThan(0)
    expect(fake.urls.length).toBeLessThanOrEqual(40)
    expect(fake.urls.filter((url) => url.startsWith("https://index.test/")).length).toBe(INDEX_URLS.length)
  })

  it("caps indexes at 8 https URLs", async () => {
    const stub = fresh()
    expect(await configure(stub, { indexes: [...INDEX_URLS, "https://index.test/extra.json"] })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await configure(stub, { indexes: ["http://index.test/xin.json"] })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
  })

  it("offers the latest dist-tag when it is compatible", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        latestTag: "1.1.0",
        versions: [
          { version: "1.0.0", xin: promptXin("PROMPT-ONE") },
          { version: "2.0.0", xin: promptXin("PROMPT-TWO") },
          { version: "1.1.0", xin: promptXin("PROMPT-ONE-ONE") },
        ],
      },
    ])
    serve(fake)
    const stub = fresh()
    expect(await cmd(stub, "tag-install", "market.install", { name: NOTES })).toMatchObject({
      ok: true,
      result: { application: "applied", version: "1.1.0" },
    })
  })

  it("describes only the offered version and returns $file values as is", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        latestTag: "2.0.0",
        versions: [
          { version: "1.0.0", xin: notesXin("PROMPT-ONE") },
          { version: "2.0.0", xin: { bundle: "not-a-list" }, engines: { xin: ">=99.0.0" } },
        ],
      },
    ])
    serve(fake)
    const stub = fresh()

    const found = await cmd(stub, "entry-offered", "market.entry", { name: NOTES })
    expect(found).toMatchObject({
      ok: true,
      result: {
        kind: "bundle",
        status: "available",
        rows: [
          { id: "style", plugin: "prompt" },
          { id: "notes", plugin: "skill", config: { markdown: { $file: "skills/notes.md" } } },
        ],
      },
    })
  })

  it("mounts the rows from the verified tarball, not the version document", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        versions: [{ version: "1.0.0", xin: promptXin("DOC-PROMPT"), tarballXin: promptXin("TARBALL-PROMPT") }],
      },
    ])
    serve(fake)
    const stub = fresh()
    expect(await cmd(stub, "tar-install", "market.install", { name: NOTES })).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    const offers = recordOffers()
    respond([offers.step("ok")])
    await turn(stub, "tar-turn")
    skillLine(offers, "TARBALL-PROMPT")
  })

  it("refuses a tarball whose kind differs from the version document", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        versions: [{ version: "1.0.0", xin: notesXin("PROMPT-ONE"), tarballXin: codeXin("Notes") }],
      },
    ])
    serve(fake)
    const stub = fresh()
    expect(await cmd(stub, "kind-install", "market.install", { name: NOTES })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("tarball declares code") },
    })
    expect((await cmd(stub, "kind-list", "bundle.list")).result).toEqual([])
  })

  it("refuses a tarball served outside the registry host", async () => {
    const fake = await fakeRegistry([
      {
        name: NOTES,
        versions: [{ version: "1.0.0", xin: promptXin("PROMPT-ONE"), tarballUrl: "https://evil.test/notes.tgz" }],
      },
    ])
    serve(fake)
    const stub = fresh()
    expect(await cmd(stub, "host-install", "market.install", { name: NOTES })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("outside") },
    })
  })

  it("does not run the update check when the market row first starts", async () => {
    const fake = await fakeRegistry([{ name: NOTES, versions: [{ version: "1.0.0", xin: promptXin("PROMPT-ONE") }] }])
    serve(fake)
    const stub = fresh()
    expect((await cmd(stub, "boot-install", "market.install", { name: NOTES })).ok).toBe(true)
    fake.urls.length = 0

    await runDurableObjectAlarm(stub)

    expect(fake.urls).toEqual([])
    const snapshot = await runInDurableObject(stub, (home: Home) => home.loader.ctx.wire.snapshot())
    expect(field(snapshot, "market")).toEqual({ updates: 0, checkedAt: null })
  })

  it("records a failed check so it does not run again at once", async () => {
    const fake = await fakeRegistry([{ name: NOTES, versions: [{ version: "1.0.0", xin: promptXin("PROMPT-ONE") }] }])
    serve(fake)
    const stub = fresh()
    await cmd(stub, "fail-install", "market.install", { name: NOTES })
    fake.packages.delete(NOTES)
    await makeCheckDue(stub)

    expect(await cmd(stub, "fail-refresh", "market.refresh")).toMatchObject({
      ok: true,
      result: { checkedAt: expect.any(Number), updates: [] },
    })
    fake.urls.length = 0

    await runDurableObjectAlarm(stub)

    expect(fake.urls).toEqual([])
  })

  it("keeps the last known version when a check cannot fetch a package", async () => {
    const fake = await fakeRegistry([{ name: NOTES, versions: [{ version: "1.0.0", xin: promptXin("PROMPT-ONE") }] }])
    serve(fake)
    const stub = fresh()
    await cmd(stub, "keep-install", "market.install", { name: NOTES })
    await fake.publish(NOTES, { version: "1.1.0", xin: promptXin("PROMPT-TWO") })
    expect(await cmd(stub, "keep-refresh-1", "market.refresh")).toMatchObject({
      ok: true,
      result: { updates: [{ package: NOTES, installed: "1.0.0", latest: "1.1.0" }] },
    })

    fake.packages.delete(NOTES)
    expect(await cmd(stub, "keep-refresh-2", "market.refresh")).toMatchObject({
      ok: true,
      result: { updates: [{ package: NOTES, installed: "1.0.0", latest: "1.1.0" }] },
    })
  })

  it("checks more than 40 installed packages across successive runs", async () => {
    const names = Array.from({ length: 45 }, (_, index) => `xin-plugin-check-${index}`)
    const fake = await fakeRegistry(
      names.map((name) => ({ name, versions: [{ version: "1.0.0", xin: promptXin("PROMPT-CHECK") }] })),
    )
    serve(fake)
    const stub = fresh()
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put(
        "plugins.bundles",
        names.map((name) => ({
          bundle: {
            package: name,
            source: { kind: "registry", version: "1.0.0", integrity: "sha512-AAAA" },
            rows: [],
            requires: [],
          },
        })),
      )
    })
    await evictDurableObject(stub)
    fake.urls.length = 0

    expect(await cmd(stub, "cap-refresh-1", "market.refresh")).toMatchObject({ ok: true })
    const first = [...fake.urls]
    expect(first).toHaveLength(40)
    fake.urls.length = 0
    expect(await cmd(stub, "cap-refresh-2", "market.refresh")).toMatchObject({ ok: true })

    const seen = new Set([...first, ...fake.urls].map((url) => new URL(url).pathname))
    for (const name of names) expect(seen.has(`/${name}`)).toBe(true)
  })

  it("prunes stored versions for packages that are no longer installed", async () => {
    const fake = await fakeRegistry([{ name: NOTES, versions: [{ version: "1.0.0", xin: promptXin("PROMPT-ONE") }] }])
    serve(fake)
    const stub = fresh()
    await cmd(stub, "prune-install", "market.install", { name: NOTES })
    await cmd(stub, "prune-refresh-1", "market.refresh")
    const stored = (): Promise<unknown> =>
      runInDurableObject(stub, (home: Home) =>
        home.db.get<{ count: number }>("SELECT count(*) AS count FROM market_versions"),
      )
    expect(await stored()).toEqual({ count: 1 })

    await cmd(stub, "prune-remove", "bundle.remove", { package: NOTES })
    await cmd(stub, "prune-refresh-2", "market.refresh")

    expect(await stored()).toEqual({ count: 0 })
  })
})
