import type { Context } from "../../src/kernel/index.ts"
import { create } from "./mcp.ts"

export const name = "mcp"
export const inject = ["host", "db", "ops", "jobs"]

export async function apply(ctx: Context): Promise<void> {
  const mcp = create({
    env: ctx.host.env,
    db: ctx.db,
    jobs: ctx.jobs,
    changed: () => ctx.emit("mcp/changed"),
  })
  ctx.provide("mcp", mcp.service)
  for (const op of mcp.ops) ctx.ops.define(op)
  await mcp.start()
}
