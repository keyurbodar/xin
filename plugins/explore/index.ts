import type { Context } from "../../src/kernel/index.ts"
import { exploreOps } from "./explore.ts"

export const name = "explore"
export const inject = ["ops"]

export function apply(ctx: Context): void {
  for (const op of exploreOps()) ctx.ops.define(op)
}
