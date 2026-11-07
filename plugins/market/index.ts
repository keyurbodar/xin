import { type Context } from "../../src/kernel/index.ts"
import { createMarket, MIGRATIONS, type MarketConfig } from "./market.ts"

export { Config, type MarketConfig } from "./market.ts"

export const name = "market"
export const inject = ["db", "packages", "ops", "clock", "wire"]

export async function apply(ctx: Context, config: MarketConfig): Promise<void> {
  await ctx.db.applySqliteMigrations("market", MIGRATIONS)
  const market = createMarket({
    config,
    fetch: (input, init) => globalThis.fetch(input, init),
    db: ctx.db,
    packages: {
      version: ctx.packages.version,
      local: ctx.packages.local,
      list: () => ctx.packages.list(),
      bundles: () => ctx.packages.bundles(),
      put: (bundle) => ctx.packages.put(bundle),
      install: (spec) => ctx.packages.install(spec),
    },
    publish: () => ctx.wire.publishHome(),
  })
  for (const op of market.ops) ctx.ops.define(op)
  ctx.wire.home(name, market.home)
  ctx.clock.timer({ due: market.due, fire: market.fire })
}
