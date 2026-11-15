import type { Context as KernelContext } from "../../src/kernel/index.ts"
import { Engine, retiredSchedules } from "./automations.ts"
import { importSchedules } from "./legacy.ts"
import { automationOps } from "./ops.ts"
import { MIGRATIONS, OWNER } from "./store.ts"

export const name = "automations"
export const inject = ["db", "harness", "intake", "clock", "pi", "ops", "push", "http", "wire"]

export async function apply(ctx: KernelContext): Promise<void> {
  await ctx.db.applySqliteMigrations(OWNER, MIGRATIONS)
  const engine = new Engine({
    db: ctx.db,
    harness: ctx.harness,
    run: (command, actor) => ctx.ops.run(command, actor),
    intake: ctx.intake,
    notify: ctx.push,
    arm: () => ctx.clock.arm(),
    changed: () => ctx.wire.publishHome(),
  })
  ctx.provide("automations", engine)
  ctx.pi.install(retiredSchedules())
  for (const op of automationOps(engine)) ctx.ops.define(op)
  ctx.clock.timer({ due: () => engine.due(), fire: (now) => engine.fire(now) })
  ctx.http.route("POST /hooks/*", (request) => engine.webhook(request, Date.now()))
  ctx.wire.home(name, async () => ({ automations: { revision: engine.revision } }))
  ctx.on("thread/settled", (event) => engine.settled(event, Date.now()))
  ctx.inject(["drive"], (inner) => {
    inner.effect(() =>
      inner.drive.attach(async (conversationId) =>
        (await engine.automationsOf(conversationId)).map((id) => ({ kind: "automation", id })),
      ),
    )
  })
  await importSchedules(engine, ctx.harness, Date.now()).catch((error: unknown) => {
    console.warn("automations: importing old schedules failed; it retries on the next boot", error)
  })
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    automations: Engine
  }
}
