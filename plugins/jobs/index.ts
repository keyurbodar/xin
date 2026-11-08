import type { Context } from "../../src/kernel/index.ts"
import { createJobs } from "./jobs.ts"
import { listJobsOp } from "./list.ts"

export const name = "jobs"
export const inject = ["pi", "harness", "clock", "intake", "ops"]

export async function apply(ctx: Context): Promise<void> {
  const jobs = createJobs({
    harness: ctx.harness,
    intake: ctx.intake,
    arm: () => ctx.clock.arm(),
  })
  ctx.provide("jobs", jobs.service)
  ctx.ops.define(listJobsOp())
  ctx.pi.install(jobs.extension)
  const stop = await jobs.start()
  ctx.effect(() => stop, "jobs.start")
}
