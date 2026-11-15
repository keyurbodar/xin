import type { Context } from "../../src/kernel/index.ts"
import { createSkills, moveToDrive } from "./skills.ts"

export const name = "skills"
export const inject = ["db", "ops", "drive"]

export async function apply(ctx: Context): Promise<void> {
  await moveToDrive(ctx.db, ctx.drive)
  const { service, ops } = createSkills(ctx.drive)
  ctx.provide("skills", service)
  for (const op of ops) ctx.ops.define(op)
}
