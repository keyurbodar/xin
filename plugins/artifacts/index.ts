import type { Context } from "../../src/kernel/index.ts"
import { artifactOps } from "./artifacts.ts"

export const name = "artifacts"
export const inject = ["harness", "ops"]

export function apply(ctx: Context): void {
  for (const op of artifactOps({ harness: ctx.harness })) ctx.ops.define(op)
}
