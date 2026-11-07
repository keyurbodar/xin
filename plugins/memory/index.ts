import type { Context } from "../../src/kernel/index.ts"
import { create } from "./memory.ts"

export const name = "memory"
export const inject = ["host", "db", "pi", "harness", "ops", "clock", "models"]

export async function apply(ctx: Context): Promise<void> {
  const memory = create({
    db: ctx.db,
    harness: ctx.harness,
    models: ctx.models,
    kek: ctx.host.env.KEK,
    arm: () => ctx.clock.arm(),
  })
  ctx.provide("memory", memory.service)
  ctx.pi.install(memory.extension)
  for (const op of memory.ops) ctx.ops.define(op)
  ctx.clock.timer({ due: memory.due, fire: memory.fire })
  await memory.start()
}
