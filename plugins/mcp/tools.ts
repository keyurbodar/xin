import { defineExtension } from "@earendil-works/pi-durable"
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search"
import type { Context } from "../../src/kernel/index.ts"

export const name = "tool-mcp"
export const inject = ["pi", "mcp"]

export function apply(ctx: Context): void {
  ctx.pi.install(createToolSearchExtension())

  let dispose: (() => void) | undefined
  const publish = (): void => {
    dispose?.()
    dispose = ctx.pi.install(defineExtension({ name: "mcp", tools: [...ctx.mcp.tools()] }))
  }

  publish()
  ctx.effect(() => ctx.mcp.watch(publish), "tool-mcp.watch")
}
