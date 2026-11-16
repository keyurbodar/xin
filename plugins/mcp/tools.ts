import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"

export const name = "tool-mcp"
export const inject = ["pi", "mcp"]

export function apply(ctx: Context): void {
  let stopSearch: (() => void) | undefined

  /** The shared `tool_search` is held only while there is an MCP tool to find. */
  const publish = (): void => {
    const tools = [...ctx.mcp.tools()]
    ctx.pi.install(defineExtension({ name: "tool-mcp", tools }))
    if (tools.length === 0) {
      stopSearch?.()
      stopSearch = undefined
      return
    }
    stopSearch ??= ctx.pi.search()
  }

  publish()
  ctx.on("mcp/changed", publish)
}
