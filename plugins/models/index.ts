import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import { FEATURE_MIGRATIONS } from "./budget.ts"
import { fastRequests } from "./fast.ts"
import { create } from "./models.ts"

export const name = "models"
export const inject = ["host", "db", "pi", "ops", "harness", "clock", "wire"]

export async function apply(ctx: Context): Promise<void> {
  await ctx.db.applySqliteMigrations("models", FEATURE_MIGRATIONS)
  const parts = create({
    db: ctx.db,
    harness: ctx.harness,
    conversations: () => ctx.pi.conversations(),
    kek: ctx.host.env.KEK,
    providers: ctx.host.providers,
    run: (command, actor) => ctx.ops.run(command, actor),
    notify: (notification) => ctx.get("push")?.notify(notification) ?? Promise.resolve(),
    alertsOn: async () => (await ctx.get("push")?.prefs())?.spend ?? true,
    goals: () => ctx.get("goals"),
    publishHome: () => ctx.wire.publishHome(),
  })
  ctx.provide("models", parts.service)
  ctx.pi.models(parts.models)
  ctx.pi.install(defineExtension({ name: "fast-mode", hooks: [fastRequests] }))
  ctx.pi.install(defineExtension({ name: "provider-health", hooks: [parts.health] }))
  ctx.pi.compaction(() => parts.compaction())
  ctx.wire.home("spend", async () => parts.home())
  for (const op of parts.ops) ctx.ops.define(op)
  ctx.clock.timer({
    due: async () => undefined,
    fire: async () => {
      await parts.flushDue()
    },
  })
  await parts.start()
}
