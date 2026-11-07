import type { ThreadSettled } from "../../src/contracts/threads.ts"
import type { Context } from "../../src/kernel/index.ts"
import { create } from "./orchestrator.ts"

export const name = "orchestrator"
export const inject = ["pi", "harness", "ops", "clock", "intake", "watchdog", "models"]

function emitSettled(ctx: Context, event: ThreadSettled): void {
  const args = ["thread/settled", event]
  for (const listener of ctx.events.dispatch("emit", args)) {
    try {
      const returned: unknown = listener(...args)
      Promise.resolve(returned).catch((error: unknown) =>
        console.warn(`${name}: a thread/settled listener rejected`, error),
      )
    } catch (error) {
      console.warn(`${name}: a thread/settled listener threw`, error)
    }
  }
}

export function apply(ctx: Context): void {
  const built = create({
    harness: ctx.harness,
    arm: (wake) => ctx.clock.arm(wake),
    run: (command, actor) => ctx.ops.run(command, actor),
    intake: ctx.intake,
    watchdog: ctx.watchdog,
    models: ctx.models,
    currentModels: () => ctx.pi.currentModels(),
    registry: ctx.pi.registry,
    settled: (event) => emitSettled(ctx, event),
  })
  ctx.provide("threads", built.threads)
  ctx.pi.install(built.extension)
  for (const op of built.ops) ctx.ops.define(op)
}
