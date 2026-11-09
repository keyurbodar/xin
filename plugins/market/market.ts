import type { SqliteDatabase, SqliteMigration } from "@earendil-works/chord/sqlite"
import { arr, bool, compile, map, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import type { JsonValue } from "@earendil-works/chord"
import {
  BundlePatchArg,
  BundleRowArg,
  normalizePatch,
  normalizeRow,
  parseSpec,
  Schema,
  specId,
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
  isSemver,
  marketInstallTarget,
  MarketIndexError,
  parseMarketIndex,
  type LocalizedText,
  type MarketIndex,
  type MarketPlugin,
  type MarketVersion,
} from "./marketindex.ts"
import { fetchJson, fetchVersion, type RegistryFailure, type VersionDocument } from "./registry.ts"
import { compatible, installationOf, kindOf, offeredVersion, type InstalledFact } from "./select.ts"
import { extractBundle, fetchTarball } from "./tarball.ts"

const MAX_REQUESTS = 40
const OWNER = ["owner"] as const
const POLICY_KEY = "market.policy"
const SKIPPED_KEY = "market.skipped"

export const Config = Schema.object({
  registry: Schema.string()
    .default("https://registry.npmjs.org")
    .description("The npm registry read for a version whose index entry names no registry."),
  indexes: Schema.array(Schema.string().pattern(/^https:\/\//))
    .default([])
    .max(8)
    .description(
      "Additional market index files in dsh's format 1, at most 8 https URLs. This build's packages are always listed first.",
    ),
  cacheTtlMs: Schema.number().min(1).default(600_000).description("How long a successfully read index stays cached."),
})

export type MarketConfig = Schemastery.TypeT<typeof Config>

export type InstalledList = {
  readonly installed: readonly { readonly package: string; readonly version: string }[]
  readonly pending: {
    readonly add: readonly string[]
    readonly remove: readonly string[]
  }
}

export type PackagesPort = {
  readonly version: string
  list(): InstalledList
  bundles(): Promise<readonly { readonly package: string; readonly source: BundleSource }[]>
  put(bundle: RuntimeBundle): Promise<BundleApplication>
  install(spec: string): void
}

export type MarketPorts = {
  readonly config: MarketConfig
  readonly fetch: typeof fetch
  readonly db: SqliteDatabase
  readonly kv: SyncKvStorage
  readonly packages: PackagesPort
  /** The index this build always offers: its compiled packages, with no setup and no fetch. */
  readonly builtin: () => MarketIndex
  /** What a compiled package's rows are, for the entry view of a provided package. */
  readonly declaration: (pkg: string) => Declaration | undefined
}

export type MarketFeature = {
  readonly ops: readonly Op[]
}

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE market_versions (package TEXT PRIMARY KEY, version TEXT NOT NULL, checked_at INTEGER NOT NULL)",
      "CREATE TABLE market_checks (id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL)",
    ],
  },
  {
    version: 2,
    statements: [
      "DROP TABLE IF EXISTS market_versions",
      "DROP TABLE IF EXISTS market_checks",
      "CREATE TABLE market_indexes (url TEXT PRIMARY KEY, document TEXT NOT NULL, expires_at INTEGER NOT NULL)",
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
const UpdateArgs = obj({
  name: str({ minLength: 1, maxLength: 200 }),
  version: str({ minLength: 1, maxLength: 100 }),
})
const PolicySchema = obj({
  autoUpdate: bool({ description: "Install newer versions without being asked." }),
})
const SkipArgs = obj({
  name: str({ minLength: 1, maxLength: 200 }),
  version: opt(str({ minLength: 1, maxLength: 100 })),
})
const policyCheck = compile(PolicySchema)
const skippedCheck = compile(map(str({ minLength: 1, maxLength: 100 })))

type Policy = Static<typeof PolicySchema>
type Skipped = Readonly<Record<string, string>>
type HistoryRow = { readonly version: string }

export type Declaration = {
  readonly rows: readonly BundleRow[]
  readonly patch: readonly BundlePatch[]
  readonly requires: readonly string[]
}

type Budget = { left: number }

type IndexSummary = {
  readonly url: string
  readonly title?: LocalizedText
  readonly description?: LocalizedText
  readonly error?: string
}

type Loaded = {
  readonly plugins: readonly MarketPlugin[]
  readonly summaries: readonly IndexSummary[]
}

type Cached = { readonly document: string; readonly expires_at: number }

function bad(message: string): never {
  throw new OpRejected("bad_args", message)
}

const failureText = (error: RegistryFailure): string => `${error.kind}: ${error.message}`

const countingFetch =
  (fetchImpl: typeof fetch, budget: Budget): typeof fetch =>
  (input, init) => {
    if (budget.left <= 0) throw new Error("the market request budget is exhausted")
    budget.left -= 1
    return fetchImpl(input, init)
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

function maybeDeclaration(xin: unknown, label: string): Declaration | undefined {
  try {
    return declarationOf(xin, label)
  } catch (error) {
    if (error instanceof OpRejected) return undefined
    throw error
  }
}

const textOf = (value: LocalizedText | undefined): readonly string[] => {
  if (value === undefined) return []
  return typeof value === "string" ? [value] : Object.values(value)
}

function matches(plugin: MarketPlugin, query: string | undefined): boolean {
  const text = query?.trim().toLowerCase() ?? ""
  if (text === "") return true
  return [plugin.name, plugin.author ?? "", ...textOf(plugin.title), ...textOf(plugin.description)].some((value) =>
    value.toLowerCase().includes(text),
  )
}

function applicationRows(application: BundleApplication): JsonValue {
  return application.application === "failed" ? application.rows.map((row) => ({ id: row.id, error: row.error })) : []
}

function factOf(
  facts: ReadonlyMap<string, InstalledFact>,
  name: string,
  version: MarketVersion | undefined,
): InstalledFact | undefined {
  const direct = facts.get(name)
  if (direct !== undefined || version === undefined) return direct
  const spec = parseSpec(marketInstallTarget(name, version).spec)
  if (spec === undefined || !facts.has(specId(spec))) return undefined
  return { kind: "installed", version: version.version }
}

export function createMarket(ports: MarketPorts): MarketFeature {
  const { config, db, kv } = ports
  const xinVersion = ports.packages.version

  const readPolicy = (): Policy => {
    const stored: unknown = kv.get(POLICY_KEY)
    return policyCheck.check(stored) ? stored : { autoUpdate: false }
  }

  const writePolicy = (policy: Policy): Policy => {
    kv.put(POLICY_KEY, policy)
    return policy
  }

  const readSkipped = (): Skipped => {
    const stored: unknown = kv.get(SKIPPED_KEY)
    return skippedCheck.check(stored) ? stored : {}
  }

  const record = (name: string, version: string): Promise<void> =>
    db.run(
      "INSERT INTO market_history (package, version, at) VALUES (?, ?, ?) " +
        "ON CONFLICT (package, version) DO UPDATE SET at = excluded.at",
      name,
      version,
      Date.now(),
    )

  const installedFacts = async (): Promise<ReadonlyMap<string, InstalledFact>> => {
    const facts = new Map<string, InstalledFact>()
    const listed = ports.packages.list()
    for (const entry of listed.installed) facts.set(entry.package, { kind: "provided" })
    for (const bundle of await ports.packages.bundles()) {
      if (facts.has(bundle.package)) continue
      facts.set(bundle.package, {
        kind: "installed",
        ...(bundle.source.kind === "registry" ? { version: bundle.source.version } : {}),
      })
    }
    for (const text of listed.pending.add) {
      const spec = parseSpec(text)
      if (spec === undefined) continue
      const id = specId(spec)
      if (facts.has(id)) continue
      facts.set(id, {
        kind: "installed",
        ...(spec.kind === "registry" && spec.range !== undefined ? { version: spec.range } : {}),
      })
    }
    return facts
  }

  const cacheRead = async (url: string, now: number): Promise<MarketIndex | undefined> => {
    const row = await db.get<Cached>("SELECT document, expires_at FROM market_indexes WHERE url = ?", url)
    if (row === undefined || row.expires_at <= now) return undefined
    try {
      return parseMarketIndex(JSON.parse(row.document), url)
    } catch {
      return undefined
    }
  }

  const cacheWrite = (url: string, index: MarketIndex, now: number): Promise<void> =>
    db.run(
      "INSERT INTO market_indexes (url, document, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (url) DO UPDATE SET document = excluded.document, expires_at = excluded.expires_at",
      url,
      JSON.stringify(index),
      now + config.cacheTtlMs,
    )

  const load = async (budget: Budget, refresh: boolean): Promise<Loaded> => {
    const now = Date.now()
    const fetched = countingFetch(ports.fetch, budget)
    const results = await Promise.all([
      Promise.resolve<{ plugins?: readonly MarketPlugin[]; summary?: IndexSummary }>({
        plugins: ports.builtin().plugins,
      }),
      ...config.indexes.map(
        async (url): Promise<{ plugins?: readonly MarketPlugin[]; summary?: IndexSummary }> => {
          if (!refresh) {
            const cached = await cacheRead(url, now)
            if (cached !== undefined) return { plugins: cached.plugins, summary: { url } }
          }
          const document = await fetchJson(fetched, url)
          if (!document.ok) return { summary: { url, error: failureText(document.error) } }
          try {
            const index = parseMarketIndex(document.value, url)
            await cacheWrite(url, index, now)
            return {
              plugins: index.plugins,
              summary: {
                url,
                title: index.title,
                ...(index.description === undefined ? {} : { description: index.description }),
              },
            }
          } catch (error) {
            if (error instanceof MarketIndexError) return { summary: { url, error: `${error.path} ${error.reason}` } }
            throw error
          }
        },
      ),
    ])
    const seen = new Set<string>()
    const plugins: MarketPlugin[] = []
    for (const result of results) {
      for (const plugin of result.plugins ?? []) {
        if (seen.has(plugin.name)) continue
        seen.add(plugin.name)
        plugins.push(plugin)
      }
    }
    return {
      plugins,
      summaries: results.flatMap((result) => (result.summary === undefined ? [] : [result.summary])),
    }
  }

  const search = async (query: string | undefined, category: string | undefined): Promise<JsonValue> => {
    const loaded = await load({ left: MAX_REQUESTS }, false)
    const facts = await installedFacts()
    const skipped = readSkipped()
    const found = loaded.plugins.filter(
      (plugin) => matches(plugin, query) && (category === undefined || plugin.metadata.category === category),
    )
    return toJson({
      entries: found.map((plugin) => {
        const offered = offeredVersion(plugin.versions, xinVersion)
        return {
          name: plugin.name,
          title: plugin.title ?? null,
          description: plugin.description ?? null,
          icon: plugin.icon ?? null,
          author: plugin.author ?? null,
          homepage: plugin.homepage ?? null,
          repository: plugin.repository ?? null,
          category: plugin.metadata.category ?? null,
          status:
            offered === undefined
              ? "not-installed"
              : installationOf(offered.version, factOf(facts, plugin.name, offered)),
          skipped: offered !== undefined && skipped[plugin.name] === offered.version,
        }
      }),
    })
  }

  const entry = async (name: string): Promise<JsonValue> => {
    const budget = { left: MAX_REQUESTS }
    const loaded = await load(budget, false)
    const plugin = loaded.plugins.find((candidate) => candidate.name === name)
    if (plugin === undefined) bad(`${name} is not in any market index`)
    const offered = offeredVersion(plugin.versions, xinVersion)
    const facts = await installedFacts()
    const provided = facts.get(name)?.kind === "provided"
    const document = provided || offered === undefined ? undefined : await versionDocument(budget, name, offered)
    const kind = provided ? "code" : document === undefined ? null : (kindOf(document.xin) ?? null)
    const declaration = provided
      ? ports.declaration(name)
      : document === undefined || kind !== "bundle"
        ? undefined
        : maybeDeclaration(document.xin, `${name}@${document.version}`)
    const skipped = readSkipped()[name]
    return toJson({
      name,
      kind,
      status: offered === undefined ? "not-installed" : installationOf(offered.version, factOf(facts, name, offered)),
      versions: plugin.versions.map((version) => ({
        version: version.version,
        publishTimestamp: version.publishTimestamp,
        compatible: compatible(version, xinVersion),
        skipped: version.version === skipped,
      })),
      readme: document?.readme ?? null,
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

  const versionDocument = async (
    budget: Budget,
    name: string,
    version: MarketVersion,
  ): Promise<VersionDocument | undefined> => {
    if (version.source.type !== "npm") return undefined
    const found = await fetchVersion(
      countingFetch(ports.fetch, budget),
      version.source.registry ?? config.registry,
      name,
      version.version,
    )
    return found.ok ? found.value : undefined
  }

  const installVersion = async (budget: Budget, name: string, version: MarketVersion): Promise<JsonValue> => {
    const target = marketInstallTarget(name, version)
    if (version.source.type === "git") {
      ports.packages.install(target.spec)
      await record(name, version.version)
      return { application: "pending", package: name, version: version.version, kind: "code", rows: [] }
    }
    const document = await fetchVersion(
      countingFetch(ports.fetch, budget),
      version.source.registry ?? config.registry,
      name,
      version.version,
    )
    if (!document.ok) {
      if (document.error.kind === "input") bad(document.error.message)
      throw new Error(`${target.spec}: ${failureText(document.error)}`)
    }
    const kind = kindOf(document.value.xin)
    if (kind === undefined) bad(`${target.spec} is not a Xin plugin`)
    if (kind === "code") {
      ports.packages.install(target.spec)
      await record(name, version.version)
      return { application: "pending", package: name, version: version.version, kind, rows: [] }
    }
    const integrity = document.value.dist.integrity
    if (integrity === undefined) bad(`${target.spec} has no dist.integrity`)
    const fetched = await fetchTarball(countingFetch(ports.fetch, budget), document.value.dist.tarball)
    if (!fetched.ok) throw new Error(`${target.spec}: ${fetched.error.message}`)
    const extracted = await extractBundle({ bytes: fetched.value, integrity })
    if (!extracted.ok) throw new Error(`${target.spec}: ${extracted.error.message}`)
    const tarballKind = kindOf(extracted.value.xin)
    if (tarballKind !== kind)
      bad(`${target.spec}: the tarball declares ${tarballKind ?? "no"} Xin plugin, the index says ${kind}`)
    const declaration = declarationOf(extracted.value.xin, target.spec)
    const application = await ports.packages.put({
      package: name,
      source: { kind: "registry", version: version.version, integrity },
      rows: declaration.rows,
      patch: declaration.patch,
      requires: declaration.requires,
    })
    if (application.application === "applied") await record(name, version.version)
    return {
      application: application.application,
      package: name,
      version: version.version,
      kind,
      rows: applicationRows(application),
    }
  }

  const install = async (
    mode: "install" | "update",
    name: string,
    requested: string | undefined,
  ): Promise<JsonValue> => {
    const budget = { left: MAX_REQUESTS }
    const loaded = await load(budget, false)
    const plugin = loaded.plugins.find((candidate) => candidate.name === name)
    if (plugin === undefined) bad(`${name} is not in any market index`)
    const facts = await installedFacts()
    if (facts.get(name)?.kind === "provided") bad(`${name} is provided by this build`)
    const target =
      requested === undefined
        ? offeredVersion(plugin.versions, xinVersion)
        : plugin.versions.find((version) => version.version === requested)
    if (target === undefined) bad(`${name} has no version ${requested ?? "to offer"}`)
    if (!compatible(target, xinVersion)) bad(`${name}@${target.version} requires xin ${target.engines.xin ?? "?"}`)
    const fact = factOf(facts, name, target)
    if (mode === "install" && fact !== undefined) bad(`${name} is already installed`)
    if (mode === "update") {
      if (fact === undefined || fact.kind !== "installed" || fact.version === undefined) bad(`${name} is not installed`)
      if (!isSemver(fact.version)) bad(`${name} is installed at a version that cannot be updated`)
      if (readSkipped()[name] === target.version)
        return toJson({ application: "skipped", package: name, version: target.version })
      if (compareVersions(target.version, fact.version) <= 0)
        bad(`${name}@${target.version} is not newer than the installed ${fact.version}`)
    }
    return installVersion(budget, name, target)
  }

  const skip = async (name: string, requested: string | undefined): Promise<JsonValue> => {
    const loaded = await load({ left: MAX_REQUESTS }, false)
    const plugin = loaded.plugins.find((candidate) => candidate.name === name)
    if (plugin === undefined) bad(`${name} is not in any market index`)
    const target =
      requested === undefined
        ? offeredVersion(plugin.versions, xinVersion)
        : plugin.versions.find((version) => version.version === requested)
    if (target === undefined) bad(`${name} has no version ${requested ?? "to offer"}`)
    kv.put(SKIPPED_KEY, { ...readSkipped(), [name]: target.version })
    return toJson({ name, version: target.version })
  }

  const unskip = (name: string): JsonValue => {
    const skipped: Record<string, string> = { ...readSkipped() }
    delete skipped[name]
    kv.put(SKIPPED_KEY, skipped)
    return toJson({ name })
  }

  const rollback = async (name: string): Promise<JsonValue> => {
    const budget = { left: MAX_REQUESTS }
    const loaded = await load(budget, false)
    const plugin = loaded.plugins.find((candidate) => candidate.name === name)
    if (plugin === undefined) bad(`${name} is not in any market index`)
    const fact = (await installedFacts()).get(name)
    if (fact === undefined || fact.kind !== "installed" || fact.version === undefined)
      return toJson({ application: "failed", package: name, reason: "not installed" })
    const current = fact.version
    const history = await db.all<HistoryRow>(
      "SELECT version FROM market_history WHERE package = ? ORDER BY at DESC, rowid DESC",
      name,
    )
    const earlier = history.find((row) => compareVersions(row.version, current) < 0)
    if (earlier === undefined) return toJson({ application: "failed", package: name, reason: "no earlier version" })
    const target = plugin.versions.find((version) => version.version === earlier.version)
    if (target === undefined)
      return toJson({
        application: "failed",
        package: name,
        reason: `${name}@${earlier.version} is not in the market index`,
      })
    if (!compatible(target, xinVersion))
      return toJson({
        application: "failed",
        package: name,
        reason: `${name}@${target.version} requires xin ${target.engines.xin ?? "?"}`,
      })
    return installVersion(budget, name, target)
  }

  /** Patch updates only: a minor or major version changes what a row means, so it asks first. */
  const autoApply = async (plugins: readonly MarketPlugin[], budget: Budget): Promise<JsonValue[]> => {
    const facts = await installedFacts()
    const skipped = readSkipped()
    const applied: JsonValue[] = []
    for (const plugin of plugins) {
      const fact = facts.get(plugin.name)
      if (fact === undefined || fact.kind !== "installed" || fact.version === undefined) continue
      if (!isSemver(fact.version)) continue
      const offered = offeredVersion(plugin.versions, xinVersion)
      if (offered === undefined || skipped[plugin.name] === offered.version) continue
      if (compareVersions(offered.version, fact.version) <= 0) continue
      const [from, to] = [fact.version.split("."), offered.version.split(".")]
      if (from[0] !== to[0] || from[1] !== to[1]) continue
      const result = await installVersion(budget, plugin.name, offered).catch((failure: unknown): JsonValue => ({
        application: "failed",
        package: plugin.name,
        version: offered.version,
        reason: failure instanceof Error ? failure.message : String(failure),
      }))
      applied.push(result)
    }
    return applied
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
      run: async (_api, args) => install("install", args.name, args.version),
    }),
    defineOp({
      name: "market.update",
      args: UpdateArgs,
      actors: OWNER,
      run: async (_api, args) => install("update", args.name, args.version),
    }),
    defineOp({
      name: "market.refresh",
      args: obj({}),
      actors: OWNER,
      run: async () => {
        const budget = { left: MAX_REQUESTS }
        const loaded = await load(budget, true)
        if (!readPolicy().autoUpdate) return toJson({ indexes: loaded.summaries })
        return toJson({ indexes: loaded.summaries, applied: await autoApply(loaded.plugins, budget) })
      },
    }),
    defineOp({
      name: "market.policy",
      args: obj({}),
      actors: OWNER,
      run: async () => toJson(readPolicy()),
    }),
    defineOp({
      name: "market.policy.set",
      args: PolicySchema,
      actors: OWNER,
      run: async (_api, args) => toJson(writePolicy({ autoUpdate: args.autoUpdate })),
    }),
    defineOp({
      name: "market.skip",
      args: SkipArgs,
      actors: OWNER,
      run: async (_api, args) => skip(args.name, args.version),
    }),
    defineOp({
      name: "market.unskip",
      args: EntryArgs,
      actors: OWNER,
      run: async (_api, args) => unskip(args.name),
    }),
    defineOp({
      name: "market.skipped",
      args: obj({}),
      actors: OWNER,
      run: async () =>
        toJson(
          Object.entries(readSkipped())
            .map(([name, version]) => ({ name, version }))
            .toSorted((left, right) => left.name.localeCompare(right.name)),
        ),
    }),
    defineOp({
      name: "market.rollback",
      args: EntryArgs,
      actors: OWNER,
      run: async (_api, args) => rollback(args.name),
    }),
  ]

  return { ops }
}
