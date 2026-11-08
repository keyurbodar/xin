import type { Context } from "../../src/kernel/index.ts"
import { create, type FailurePorts } from "./failures.ts"

export const name = "failures"
export const inject = ["harness", "ops", "clock", "intake"]

export async function apply(ctx: Context): Promise<void> {
  const ports: FailurePorts = {
    harness: ctx.harness,
    intake: ctx.intake,
    arm: () => ctx.clock.arm(),
  }
  const failures = create(ports)
  ctx.ops.define(failures.retry)
  const stop = await failures.start()
  if (stop !== undefined) ctx.effect(() => stop, `${name}.start`)
}
