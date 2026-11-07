import type { Context } from "../../src/kernel/index.ts"
import { createSkills } from "./skills.ts"

export const name = "skills"
export const inject = ["db", "ops"]

export function apply(ctx: Context): void {
  const { service, ops } = createSkills(ctx.db)
  ctx.provide("skills", service)
  for (const op of ops) ctx.ops.define(op)
}
