import { type Context, Schema } from "../../src/kernel/index.ts"
import { createJobs, JOB_WAIT_MS } from "./jobs.ts"
import { listJobsOp } from "./list.ts"

export const name = "jobs"
export const inject = ["pi", "harness", "clock", "intake", "ops"]

export const Config = Schema.object({
  waitMs: Schema.number()
    .min(0)
    .max(600_000)
    .step(1)
    .default(JOB_WAIT_MS)
    .description("How long a coordinator's tool call waits for its job before it returns started and reports later."),
})

type Config = { readonly waitMs: number }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const jobs = createJobs({
    harness: ctx.harness,
    intake: ctx.intake,
    waitMs: config.waitMs,
    arm: () => ctx.clock.arm(),
  })
  ctx.provide("jobs", jobs.service)
  ctx.ops.define(listJobsOp())
  ctx.pi.install(jobs.extension)
  const stop = await jobs.start()
  ctx.effect(() => stop, "jobs.start")
}
