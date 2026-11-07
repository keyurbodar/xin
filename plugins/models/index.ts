import type { Context } from "../../src/kernel/index.ts"
import { create } from "./models.ts"

export const name = "models"
export const inject = ["host", "db", "pi", "ops"]

export async function apply(ctx: Context): Promise<void> {
  const parts = create({
    db: ctx.db,
    kek: ctx.host.env.KEK,
    providers: ctx.host.providers,
    run: (command, actor) => ctx.ops.run(command, actor),
  })
  ctx.provide("models", parts.service)
  ctx.pi.models(parts.models)
  for (const op of parts.ops) ctx.ops.define(op)
  await parts.start()
}
