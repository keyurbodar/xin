import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"

export const name = "tool-mcp"
export const inject = ["pi", "mcp"]

export function apply(ctx: Context): void {
  const publish = (): void => {
    ctx.pi.install(defineExtension({ name: "tool-mcp", tools: [...ctx.mcp.tools()] }))
  }

  publish()
  ctx.on("mcp/changed", publish)
}
