import type { Context } from "../../src/kernel/index.ts"
import { create } from "./drive.ts"

export const name = "drive"
export const inject = ["host", "files", "harness", "pi", "ops"]

export function apply(ctx: Context): void {
  const drive = create({ files: ctx.files, harness: ctx.harness, bucket: ctx.host.env.FILES })
  ctx.provide("drive", drive.service)
  ctx.pi.install(drive.extension)
  for (const op of drive.ops) ctx.ops.define(op)
  ctx.effect(() => ctx.files.watch(drive.changed))
  ctx.effect(() => ctx.files.grant(({ conversationId, path }) => drive.grant(conversationId, path)))
}
