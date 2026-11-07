import { type Context } from "../../src/kernel/index.ts"
import { createMarket, MIGRATIONS, type MarketConfig } from "./market.ts"

export { Config, type MarketConfig } from "./market.ts"

export const name = "market"
export const inject = ["host", "db", "packages", "ops"]

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
  })
  for (const op of market.ops) ctx.ops.define(op)
}
