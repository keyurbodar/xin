import { defineExtension } from "@earendil-works/pi-durable"
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search"
import type { Context } from "../../src/kernel/index.ts"

export const name = "tool-mcp"
export const inject = ["pi", "mcp"]

export function apply(ctx: Context): void {
  ctx.pi.install(createToolSearchExtension())

  const publish = (): void => {
    ctx.pi.install(defineExtension({ name: "tool-mcp", tools: [...ctx.mcp.tools()] }))
  }

  publish()
  ctx.on("mcp/changed", publish)
}
