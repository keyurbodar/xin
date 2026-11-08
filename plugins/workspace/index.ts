import { defineExtension, section } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import { create } from "./workspace.ts"

export const name = "workspace"
export const inject = ["harness", "wire", "ops", "pi", "host"]

export async function apply(ctx: Context): Promise<void> {
  const workspace = create({
    harness: ctx.harness,
    kv: ctx.host.state.storage.kv,
    publishHome: () => ctx.wire.publishHome(),
  })
  for (const op of workspace.ops) ctx.ops.define(op)
  ctx.pi.install(
    defineExtension({
      name: "xin.instructions",
      sections: [section("owner", () => workspace.instructions())],
    }),
  )
  ctx.wire.home(name, workspace.home)
  const stop = await workspace.start()
  ctx.effect(() => stop, `${name}.start`)
}
