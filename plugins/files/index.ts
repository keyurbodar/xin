import type { Context } from "../../src/kernel/index.ts"
import { create } from "./files.ts"

export const name = "files"
export const inject = ["host", "db", "pi", "ops", "http", "clock"]

export async function apply(ctx: Context): Promise<void> {
  const files = create({ state: ctx.host.state, env: ctx.host.env, db: ctx.db })
  ctx.provide("files", files.service)
  ctx.pi.install(files.scope)
  for (const op of files.ops) ctx.ops.define(op)
  ctx.http.route("POST /v1/files/commit", files.commit)
  ctx.clock.timer({ due: files.due, fire: files.fire })
  await files.start()
}
