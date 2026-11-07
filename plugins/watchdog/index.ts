import type { Context } from "../../src/kernel/index.ts"
import { ensureWatchdog, ensureWatchdogTx, watchdogExtension, watchdogTask, type WatchdogPorts } from "./watchdog.ts"

export const name = "watchdog"
export const inject = ["pi", "harness", "clock", "intake", "jobs"]

export async function apply(ctx: Context): Promise<void> {
  const ports: WatchdogPorts = {
    harness: ctx.harness,
    jobs: ctx.jobs,
    intake: ctx.intake,
    arm: () => ctx.clock.arm(),
  }
  const task = watchdogTask(ports)
  ctx.provide("watchdog", { ensure: (tx, conversationId) => ensureWatchdogTx(tx, task, conversationId) })
  ctx.pi.install(watchdogExtension(ports, task))
  ctx.clock.timer({ due: async () => undefined, fire: async () => ensureWatchdog(ports, task) })
  await ensureWatchdog(ports, task)
}
