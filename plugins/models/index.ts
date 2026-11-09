import type { Context } from "../../src/kernel/index.ts"
import { create } from "./models.ts"

export const name = "models"
export const inject = ["host", "db", "pi", "ops", "harness", "clock"]

export async function apply(ctx: Context): Promise<void> {
  const parts = create({
    db: ctx.db,
    harness: ctx.harness,
    kek: ctx.host.env.KEK,
    providers: ctx.host.providers,
    run: (command, actor) => ctx.ops.run(command, actor),
    notify: (notification) => ctx.get("push")?.notify(notification) ?? Promise.resolve(),
    alertsOn: async () => (await ctx.get("push")?.prefs())?.spend ?? true,
  })
  ctx.provide("models", parts.service)
  ctx.pi.models(parts.models)
  for (const op of parts.ops) ctx.ops.define(op)
  ctx.clock.timer({
    due: async () => undefined,
    fire: async () => {
      await parts.flushDue()
    },
  })
  await parts.start()
}
