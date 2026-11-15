import type { Context } from "../../src/kernel/index.ts"
import {
  scheduledConversations,
  scheduleOps,
  schedulesExtension,
  schedulesService,
  type SchedulesPort,
} from "./schedules.ts"

export const name = "schedules"
export const inject = ["harness", "intake", "clock", "pi", "ops", "push", "models"]

export function apply(ctx: Context): void {
  const port: SchedulesPort = {
    harness: ctx.harness,
    intake: ctx.intake,
    notify: ctx.push,
    arm: () => ctx.clock.arm(),
    admit: () => ctx.models.admit("automation"),
  }
  const service = schedulesService(port)
  ctx.provide("schedules", service)
  ctx.pi.install(schedulesExtension(port))
  for (const op of scheduleOps(service)) ctx.ops.define(op)
  ctx.effect(
    () => ctx.models.track({ feature: "automation", conversations: () => scheduledConversations(ctx.harness) }),
    "models.track(automation)",
  )
}
