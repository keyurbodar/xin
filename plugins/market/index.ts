import { type Context, pluginOf, sourcePackage, sourceVersion, toJson } from "../../src/kernel/index.ts"
import { createMarket, type Declaration, MIGRATIONS, type MarketConfig } from "./market.ts"
import type { MarketIndex } from "./marketindex.ts"

export { Config, type MarketConfig } from "./market.ts"

export const name = "market"
export const inject = ["host", "db", "kernel", "packages", "plugins", "ops"]

type PackageGroup = {
  readonly title: string
  readonly description: string
  readonly version: string
  readonly plugins: string[]
}

/** The build's compiled feature packages, as a market index. No index URL, no setup, no fetch. */
function builtinIndex(catalog: readonly { readonly [key: string]: unknown }[]): MarketIndex {
  const groups = new Map<string, PackageGroup>()
  for (const entry of catalog) {
    const pluginName = typeof entry["name"] === "string" ? entry["name"] : undefined
    const source = typeof entry["source"] === "string" ? entry["source"] : undefined
    if (pluginName === undefined || source === undefined) continue
    if (source === "xin") continue
    const pkg = sourcePackage(source)
    const group = groups.get(pkg)
    if (group !== undefined) {
      group.plugins.push(pluginName)
      continue
    }
    groups.set(pkg, {
      title: typeof entry["title"] === "string" ? entry["title"] : pkg,
      description: typeof entry["description"] === "string" ? entry["description"] : "",
      version: sourceVersion(source),
      plugins: [pluginName],
    })
  }
  return {
    format: 1,
    title: "Xin",
    description: "Plugins compiled into this build.",
    metadata: { categories: { "first-party": { title: "First party" } }, labels: {}, sortKeys: {} },
    plugins: [...groups].map(([pkg, group]) => ({
      name: pkg,
      title: group.title,
      description: group.description,
      metadata: { category: "first-party", keywords: group.plugins, labels: [], sortKeys: {} },
      versions: [{ version: group.version, publishTimestamp: 0, source: { type: "npm" }, engines: {} }],
    })),
  }
}

export async function apply(ctx: Context, config: MarketConfig): Promise<void> {
  await ctx.db.applySqliteMigrations("market", MIGRATIONS)
  const market = createMarket({
    config,
    fetch: (input, init) => globalThis.fetch(input, init),
    db: ctx.db,
    kv: ctx.host.state.storage.kv,
    packages: {
      version: ctx.packages.version,
      list: () => ctx.packages.list(),
      bundles: () => ctx.packages.bundles(),
      put: (bundle) => ctx.packages.put(bundle),
      install: (spec) => void ctx.packages.install(spec),
    },
    builtin: () => builtinIndex(ctx.plugins.catalog()),
    declaration: (pkg): Declaration | undefined => {
      const rows = ctx.kernel.composition.bundles[pkg]
      if (rows === undefined) return undefined
      return {
        rows: rows.map((row) => ({
          id: row.id,
          plugin: pluginOf(row),
          ...(row.config === undefined ? {} : { config: toJson(row.config) }),
          ...(row.disabled === true ? { disabled: true } : {}),
        })),
        patch: [],
        requires: [],
      }
    },
  })
  for (const op of market.ops) ctx.ops.define(op)
}
