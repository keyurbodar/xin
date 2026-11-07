import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import type { JsonObject } from "@earendil-works/pi-durable"
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema"
import {
  BundlePatchArg,
  BundleRowArg,
  normalizePatch,
  normalizeRow,
  Schema,
  sourcePackage,
  toJson,
  type BundleApplication,
  type BundlePatch,
  type BundleRow,
  type BundleSource,
  type RuntimeBundle,
} from "../../src/kernel/index.ts"
import { defineOp, OpRejected, type Op } from "../../src/ops.ts"
import { compareVersions } from "../../src/semver.ts"
import {
  registry,
  type Abbreviated,
  type IndexEntry,
  type Registry,
  type RegistryFailure,
  type RegistryVersion,
} from "./registry.ts"
import { compatible, kindOf, offeredVersion, status, type MarketStatus, type PackageKind } from "./select.ts"
import { extractBundle, fetchTarball, inlineFiles, tarballAllowed } from "./tarball.ts"

export const MAX_CHECK_REQUESTS = 40
export const MAX_SEARCH_ENTRIES = 20

const MAX_REQUESTS = 40
const HOUR_MS = 3_600_000
const OWNER = ["owner"] as const

export const Config = Schema.object({
  registry: Schema.string()
    .default("https://registry.npmjs.org")
    .description("The npm registry the market reads and the host a bundle tarball must come from."),
  indexes: Schema.array(Schema.string().pattern(/^https:\/\//))
    .default([])
    .max(8)
    .description("Static market index files, in dsh's format 1, at most 8 https URLs."),
  search: Schema.boolean().default(true).description("Also search the registry for the keyword xin-plugin."),
  checkHours: Schema.number().min(1).default(24).description("How often the update check runs."),
})

export type MarketConfig = Schemastery.TypeT<typeof Config>

export type PendingList = {
  readonly add: readonly string[]
  readonly remove: readonly string[]
}

export type InstalledList = {
  readonly installed: readonly { readonly package: string; readonly version: string }[]
  readonly pending: PendingList
}

export type PackagesPort = {
  readonly version: string
  readonly local: readonly string[]
  list(): InstalledList
  bundles(): Promise<readonly { readonly package: string; readonly source: BundleSource }[]>
  put(bundle: RuntimeBundle): Promise<BundleApplication>
  install(spec: string): void
}

export type MarketPorts = {
  readonly config: MarketConfig
  readonly fetch: typeof fetch
  readonly db: SqliteDatabase
  readonly packages: PackagesPort
  readonly publish: () => Promise<void>
}

export type Update = { readonly package: string; readonly installed: string; readonly latest: string }

export type Updates = { readonly checkedAt: number | null; readonly updates: readonly Update[] }

export type MarketFeature = {
  readonly ops: readonly Op[]
  readonly home: () => Promise<JsonObject>
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
  refresh(): Promise<Updates>
}

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE market_versions (package TEXT PRIMARY KEY, version TEXT NOT NULL, checked_at INTEGER NOT NULL)",
      "CREATE TABLE market_checks (id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL)",
    ],
  },
]

const BundleSchema = obj(
  {
    bundle: arr(BundleRowArg),
    patch: opt(arr(BundlePatchArg)),
    requires: opt(arr(str({ minLength: 1, maxLength: 200 }))),
  },
  { open: true },
)
const bundleCheck = compile(BundleSchema)

const SearchArgs = obj({ query: opt(str({ maxLength: 200 })), category: opt(str({ maxLength: 100 })) })
const EntryArgs = obj({ name: str({ minLength: 1, maxLength: 200 }) })
const InstallArgs = obj({
  name: str({ minLength: 1, maxLength: 200 }),
  version: opt(str({ minLength: 1, maxLength: 100 })),
})

const failureText = (error: RegistryFailure): string => `${error.kind}: ${error.message}`

function bad(message: string): never {
  throw new OpRejected("bad_args", message)
}

type Declaration = {
  readonly rows: readonly BundleRow[]
  readonly patch: readonly BundlePatch[]
  readonly requires: readonly string[]
}

function declarationOf(xin: unknown, label: string): Declaration {
  if (!bundleCheck.check(xin)) {
    const first = bundleCheck.errors(xin)[0]
    return bad(`${label} declares an invalid bundle${first === undefined ? "" : `: ${first.path} ${first.message}`}`)
  }
  return {
    rows: xin.bundle.map((row) =>
      normalizeRow({ id: row.id, plugin: row.plugin, config: toJson(row.config), disabled: row.disabled }),
    ),
    patch: (xin.patch ?? []).map((entry) =>
      normalizePatch({ id: entry.id, config: toJson(entry.config), disabled: entry.disabled }),
    ),
    requires: [...(xin.requires ?? [])],
  }
}

type InstalledFact = {
  readonly version: string
  readonly source: "code" | "bundle"
  readonly local: boolean
  readonly pending?: string
}

type Installed = ReadonlyMap<string, InstalledFact>

type SearchItem = {
  readonly name: string
  readonly title: string | null
  readonly description: string | null
  readonly icon: string | null
  readonly author: string | null
  readonly repository: string | null
  readonly kind: PackageKind | null
  readonly status: MarketStatus
}

type Budget = { left: number }

const budgetOf = (limit: number): Budget => ({ left: limit })

const countingFetch =
  (fetchImpl: typeof fetch, budget: Budget): typeof fetch =>
  (input, init) => {
    if (budget.left <= 0) throw new Error("the market request budget is exhausted")
    budget.left -= 1
    return fetchImpl(input, init)
  }

const checkTargets = (
  known: Installed,
  checked: ReadonlyMap<string, number>,
): readonly { readonly package: string; readonly version: string; readonly checkedAt: number }[] =>
  [...known]
    .filter(([, fact]) => !fact.local && fact.version !== "")
    .map(([name, fact]) => ({ package: name, version: fact.version, checkedAt: checked.get(name) ?? 0 }))
    .toSorted((left, right) => left.checkedAt - right.checkedAt || left.package.localeCompare(right.package))

const updatesOf = (known: Installed, stored: ReadonlyMap<string, string>): readonly Update[] => {
  const found: Update[] = []
  for (const [name, fact] of known) {
    if (fact.local || fact.version === "") continue
    const latest = stored.get(name)
    if (latest === undefined || compareVersions(latest, fact.version) <= 0) continue
    found.push({ package: name, installed: fact.version, latest })
  }
  return found.toSorted((left, right) => left.package.localeCompare(right.package))
}

export function createMarket(ports: MarketPorts): MarketFeature {
  const { config, db } = ports
  const xinVersion = ports.packages.version
  const startedAt = Date.now()
  const apiFor = (budget: Budget): Registry =>
    registry({ fetch: countingFetch(ports.fetch, budget), baseUrl: config.registry })

  const installedFacts = async (): Promise<Installed> => {
    const listed = ports.packages.list()
    const locals = new Set(ports.packages.local)
    const facts = new Map<string, InstalledFact>()
    for (const entry of listed.installed) {
      facts.set(entry.package, { version: entry.version, source: "code", local: locals.has(entry.package) })
    }
    for (const bundle of await ports.packages.bundles()) {
      if (facts.has(bundle.package)) continue
      const local = bundle.source.kind === "local"
      facts.set(bundle.package, {
        version: local ? "local" : bundle.source.version,
        source: "bundle",
        local: local || locals.has(bundle.package),
      })
    }
    for (const spec of listed.pending.add) {
      const name = sourcePackage(spec)
      const fact = facts.get(name)
      facts.set(
        name,
        fact === undefined ? { version: "", source: "code", local: false, pending: spec } : { ...fact, pending: spec },
      )
    }
    return facts
  }

  const statusOf = (name: string, abbreviated: Abbreviated, known: Installed): MarketStatus => {
    const fact = known.get(name)
    return status({
      local: fact?.local === true,
      ...(fact === undefined || fact.version === "" ? {} : { installed: { version: fact.version } }),
      ...(fact?.pending === undefined ? {} : { pending: fact.pending }),
      versions: abbreviated.versions,
      distTags: abbreviated.distTags,
      xinVersion,
    })
  }

  const discover = async (api: Registry, query: string | undefined): Promise<readonly IndexEntry[]> => {
    const [indexResults, searchResult] = await Promise.all([
      Promise.all(config.indexes.map((url) => api.index(url))),
      config.search ? api.search(query ?? "") : Promise.resolve(undefined),
    ])
    const merged = new Map<string, IndexEntry>()
    const sources = config.indexes.length + (config.search ? 1 : 0)
    let reached = 0
    for (const found of indexResults) {
      if (!found.ok) continue
      reached += 1
      for (const entry of found.value)
        if (!merged.has(entry.name) && matches(entry, query)) merged.set(entry.name, entry)
    }
    if (searchResult !== undefined && searchResult.ok) {
      reached += 1
      for (const hit of searchResult.value)
        if (!merged.has(hit.name))
          merged.set(hit.name, {
            name: hit.name,
            ...(hit.description === undefined ? {} : { description: hit.description }),
          })
    }
    if (sources > 0 && reached === 0) throw new Error("no market source could be reached")
    return [...merged.values()]
  }

  const search = async (query: string | undefined, category: string | undefined): Promise<JsonValue> => {
    const budget = budgetOf(MAX_REQUESTS)
    const api = apiFor(budget)
    const matched = (await discover(api, query)).filter((entry) => matchesCategory(entry, category))
    const found = matched.slice(0, MAX_SEARCH_ENTRIES)
    const known = await installedFacts()
    const items: SearchItem[] = []
    for (const entry of found) {
      if (budget.left < 1) break
      const abbreviated = await api.abbreviated(entry.name)
      if (!abbreviated.ok) continue
      const newest = offeredVersion(abbreviated.value.versions, abbreviated.value.distTags, xinVersion)
      let kind: PackageKind | null = null
      if (newest !== undefined && budget.left >= 1) {
        const document = await api.version(entry.name, newest.version)
        if (document.ok) kind = kindOf(document.value.xin) ?? null
      }
      items.push({
        name: entry.name,
        title: entry.title ?? null,
        description: entry.description ?? null,
        icon: entry.icon ?? null,
        author: entry.author ?? null,
        repository: entry.repository ?? null,
        kind,
        status: statusOf(entry.name, abbreviated.value, known),
      })
    }
    return { entries: items }
  }

  const entry = async (name: string): Promise<JsonValue> => {
    const api = apiFor(budgetOf(MAX_REQUESTS))
    const abbreviated = await api.abbreviated(name)
    if (!abbreviated.ok) {
      if (abbreviated.error.kind === "input") bad(abbreviated.error.message)
      throw new Error(`${name}: ${failureText(abbreviated.error)}`)
    }
    const versions = abbreviated.value.versions.toSorted((left, right) => compareVersions(right.version, left.version))
    const chosen = offeredVersion(versions, abbreviated.value.distTags, xinVersion)
    const document = chosen === undefined ? undefined : await api.version(name, chosen.version)
    const kind = document !== undefined && document.ok ? (kindOf(document.value.xin) ?? null) : null
    const declaration =
      kind === "bundle" && document !== undefined && document.ok
        ? maybeDeclaration(document.value.xin, `${name}@${document.value.version}`)
        : undefined
    const known = await installedFacts()
    return toJson({
      name,
      kind,
      status: statusOf(name, abbreviated.value, known),
      versions: versions.map((version) => ({
        version: version.version,
        compatible: compatible(version, xinVersion),
        deprecated: version.deprecated ?? null,
        publishedAt: abbreviated.value.time?.[version.version] ?? null,
      })),
      readme: document !== undefined && document.ok ? (document.value.readme ?? null) : null,
      requires: declaration === undefined ? [] : [...declaration.requires],
      rows:
        declaration === undefined
          ? []
          : declaration.rows.map((row) => ({
              id: row.id,
              plugin: row.plugin,
              config: row.config ?? null,
              disabled: row.disabled === true,
            })),
    })
  }

  const install = async (
    name: string,
    requested: string | undefined,
    mode: "install" | "update",
  ): Promise<JsonValue> => {
    const known = await installedFacts()
    const fact = known.get(name)
    if (fact?.local === true) bad(`${name} is a local package`)
    if (mode === "update" && (fact === undefined || fact.local)) bad(`${name} is not installed`)

    const budget = budgetOf(MAX_REQUESTS)
    const api = apiFor(budget)
    const abbreviated = await api.abbreviated(name)
    if (!abbreviated.ok) {
      if (abbreviated.error.kind === "input") bad(abbreviated.error.message)
      throw new Error(`${name}: ${failureText(abbreviated.error)}`)
    }
    const target = resolveTarget(name, abbreviated.value, requested, xinVersion)
    const document = await api.version(name, target.version)
    if (!document.ok) throw new Error(`${name}@${target.version}: ${failureText(document.error)}`)
    const kind = kindOf(document.value.xin)
    if (kind === undefined) bad(`${name}@${target.version} is not a Xin plugin`)
    if (kind === "code") {
      ports.packages.install(`${name}@${target.version}`)
      return { application: "pending", package: name, version: target.version, kind, rows: [] }
    }
    const integrity = document.value.dist.integrity
    if (integrity === undefined) bad(`${name}@${target.version} has no dist.integrity`)
    if (!tarballAllowed(document.value.dist.tarball, config.registry))
      bad(`${name}@${target.version} serves its tarball outside ${config.registry}`)
    const fetched = await fetchTarball(countingFetch(ports.fetch, budget), document.value.dist.tarball)
    if (!fetched.ok) throw new Error(`${name}@${target.version}: ${fetched.error.message}`)
    const extracted = await extractBundle({ bytes: fetched.value, integrity })
    if (!extracted.ok) throw new Error(`${name}@${target.version}: ${extracted.error.message}`)
    const tarballKind = kindOf(extracted.value.xin)
    if (tarballKind !== kind)
      bad(
        `${name}@${target.version}: the tarball declares ${tarballKind ?? "no"} Xin plugin, the registry says ${kind}`,
      )
    const declaration = declarationOf(extracted.value.xin, `${name}@${target.version}`)
    const inlined = inlineFiles(declaration.rows, extracted.value.read)
    if (!inlined.ok) throw new Error(`${name}@${target.version}: ${inlined.error.message}`)
    const application = await ports.packages.put({
      package: name,
      source: { kind: "registry", version: target.version, integrity },
      rows: inlined.value,
      patch: declaration.patch,
      requires: declaration.requires,
    })
    return {
      application: application.application,
      package: name,
      version: target.version,
      kind,
      rows: applicationRows(application),
    }
  }

  const lastCheckedAt = async (): Promise<number | null> => {
    const row = await db.get<{ checked_at: number }>("SELECT checked_at FROM market_checks WHERE id = 'last'")
    return row?.checked_at ?? null
  }

  const storedVersions = async (): Promise<Map<string, string>> => {
    const rows = await db.all<{ package: string; version: string }>("SELECT package, version FROM market_versions")
    return new Map(rows.map((row): [string, string] => [row.package, row.version]))
  }

  const checkedTimes = async (): Promise<Map<string, number>> => {
    const rows = await db.all<{ package: string; checked_at: number }>(
      "SELECT package, checked_at FROM market_versions",
    )
    return new Map(rows.map((row): [string, number] => [row.package, row.checked_at]))
  }

  const storeVersion = (name: string, version: string, at: number): Promise<void> =>
    db.run(
      "INSERT INTO market_versions (package, version, checked_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (package) DO UPDATE SET version = excluded.version, checked_at = excluded.checked_at",
      name,
      version,
      at,
    )

  const recordCheck = (at: number): Promise<void> =>
    db.run(
      "INSERT INTO market_checks (id, checked_at) VALUES ('last', ?) " +
        "ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at",
      at,
    )

  const prune = async (known: Installed): Promise<void> => {
    const names = [...known.keys()]
    if (names.length === 0) {
      await db.run("DELETE FROM market_versions")
      return
    }
    await db.run(`DELETE FROM market_versions WHERE package NOT IN (${names.map(() => "?").join(", ")})`, ...names)
  }

  const check = async (): Promise<Updates> => {
    const at = Date.now()
    const api = apiFor(budgetOf(MAX_REQUESTS))
    try {
      const known = await installedFacts()
      const checked = await checkedTimes()
      await prune(known)
      const targets = checkTargets(known, checked).slice(0, MAX_CHECK_REQUESTS)
      for (const target of targets) {
        const abbreviated = await api.abbreviated(target.package)
        if (!abbreviated.ok) continue
        const latest = offeredVersion(abbreviated.value.versions, abbreviated.value.distTags, xinVersion)?.version
        if (latest === undefined) continue
        await storeVersion(target.package, latest, at)
      }
    } finally {
      await recordCheck(at)
    }
    const updates = updatesOf(await installedFacts(), await storedVersions())
    await ports.publish()
    return { checkedAt: at, updates }
  }

  const refresh = (): Promise<Updates> => check()

  const due = async (): Promise<number> => {
    const last = await lastCheckedAt()
    return (last ?? startedAt) + config.checkHours * HOUR_MS
  }

  const fire = async (now: number): Promise<void> => {
    if (now < (await due())) return
    await refresh().catch((error: unknown) => console.warn("market: update check failed", error))
  }

  const home = async (): Promise<JsonObject> => {
    const checkedAt = await lastCheckedAt()
    const updates = checkedAt === null ? [] : updatesOf(await installedFacts(), await storedVersions())
    return { market: { updates: updates.length, checkedAt } }
  }

  const ops: readonly Op[] = [
    defineOp({
      name: "market.search",
      args: SearchArgs,
      actors: OWNER,
      run: async (_api, args) => search(args.query, args.category),
    }),
    defineOp({
      name: "market.entry",
      args: EntryArgs,
      actors: OWNER,
      run: async (_api, args) => entry(args.name),
    }),
    defineOp({
      name: "market.install",
      args: InstallArgs,
      actors: OWNER,
      run: async (_api, args) => install(args.name, args.version, "install"),
    }),
    defineOp({
      name: "market.update",
      args: InstallArgs,
      actors: OWNER,
      run: async (_api, args) => install(args.name, args.version, "update"),
    }),
    defineOp({
      name: "market.refresh",
      args: obj({}),
      actors: OWNER,
      run: async () => updatesJson(await refresh()),
    }),
    defineOp({
      name: "market.updates",
      args: obj({}),
      actors: OWNER,
      run: async () =>
        updatesJson({
          checkedAt: await lastCheckedAt(),
          updates: updatesOf(await installedFacts(), await storedVersions()),
        }),
    }),
  ]

  return { ops, home, due, fire, refresh }
}

function maybeDeclaration(xin: unknown, label: string): Declaration | undefined {
  try {
    return declarationOf(xin, label)
  } catch (error) {
    if (error instanceof OpRejected) return undefined
    throw error
  }
}

function resolveTarget(
  name: string,
  abbreviated: Abbreviated,
  requested: string | undefined,
  xinVersion: string,
): RegistryVersion {
  if (requested === undefined) {
    const newest = offeredVersion(abbreviated.versions, abbreviated.distTags, xinVersion)
    if (newest === undefined) bad(`${name} has no version compatible with this Xin build`)
    return newest
  }
  const found = abbreviated.versions.find((version) => version.version === requested)
  if (found === undefined) bad(`${name} has no version ${requested}`)
  if (!compatible(found, xinVersion)) bad(`${name}@${requested} requires xin ${found.engines?.xin ?? "?"}`)
  return found
}

function updatesJson(updates: Updates): JsonValue {
  return {
    checkedAt: updates.checkedAt,
    updates: updates.updates.map((entry) => ({
      package: entry.package,
      installed: entry.installed,
      latest: entry.latest,
    })),
  }
}

function applicationRows(application: BundleApplication): JsonValue {
  return application.application === "failed" ? application.rows.map((row) => ({ id: row.id, error: row.error })) : []
}

function matches(entry: IndexEntry, query: string | undefined): boolean {
  const text = query?.trim().toLowerCase() ?? ""
  if (text === "") return true
  return [entry.name, entry.title, entry.description].some((value) => value?.toLowerCase().includes(text) === true)
}

function matchesCategory(entry: IndexEntry, category: string | undefined): boolean {
  return category === undefined || entry.metadata?.categories?.includes(category) === true
}
