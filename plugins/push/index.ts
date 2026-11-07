import type { Context } from "../../src/kernel/index.ts"
import { notifier, pushOps } from "./push.ts"

export const name = "push"
export const inject = ["host", "db", "ops", "clock"]

export function apply(ctx: Context): void {
  const push = notifier({ state: ctx.host.state, db: ctx.db })
  ctx.provide("push", push)
  for (const op of pushOps(ctx.db)) ctx.ops.define(op)
  ctx.clock.timer({
    due: () => push.due(),
    fire: async (at) => {
      await push.flush(at)
    },
  })
}
