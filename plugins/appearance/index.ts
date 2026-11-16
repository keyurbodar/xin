import type { Context } from "../../src/kernel/index.ts"
import { createAppearance, MIGRATIONS } from "./appearance.ts"

export const name = "appearance"
export const inject = ["db", "ops"]

export async function apply(ctx: Context): Promise<void> {
  await ctx.db.applySqliteMigrations("appearance", MIGRATIONS)
  for (const op of createAppearance(ctx.db)) ctx.ops.define(op)
}
