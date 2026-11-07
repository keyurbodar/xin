import type { Context } from "../../src/kernel/index.ts"
import { notifier, pushOps } from "./push.ts"

export const name = "push"
export const inject = ["host", "db", "ops"]

export function apply(ctx: Context): void {
  ctx.provide("push", notifier({ state: ctx.host.state, db: ctx.db }))
  for (const op of pushOps(ctx.db)) ctx.ops.define(op)
}
