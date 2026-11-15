import type { Context } from "../../src/kernel/index.ts"
import { create } from "./drive.ts"
import { MIGRATIONS } from "./shares.ts"

export const name = "drive"
export const inject = ["db", "files", "harness", "pi", "ops"]

export async function apply(ctx: Context): Promise<void> {
  await ctx.db.applySqliteMigrations("drive", MIGRATIONS)
  const drive = create({ db: ctx.db, files: ctx.files, harness: ctx.harness })
  ctx.provide("drive", drive.service)
  ctx.pi.install(drive.extension)
  for (const op of drive.ops) ctx.ops.define(op)
  ctx.effect(() => ctx.files.watch(drive.changed))
  ctx.effect(() => ctx.files.grant(({ conversationId, path }) => drive.grant(conversationId, path)))
}
