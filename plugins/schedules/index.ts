import type { Context } from "../../src/kernel/index.ts"
import { scheduleOps, schedulesExtension, schedulesService, type SchedulesPort } from "./schedules.ts"

export const name = "schedules"
export const inject = ["harness", "intake", "clock", "pi", "ops"]

export function apply(ctx: Context): void {
  const port: SchedulesPort = {
    harness: ctx.harness,
    intake: ctx.intake,
    arm: () => ctx.clock.arm(),
  }
  const service = schedulesService(port)
  ctx.provide("schedules", service)
  ctx.pi.install(schedulesExtension(port))
  for (const op of scheduleOps(service)) ctx.ops.define(op)
}
