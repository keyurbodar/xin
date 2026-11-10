import { defineExtension } from "@earendil-works/pi-durable"
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search"
import type { Context } from "../../src/kernel/index.ts"

export const name = "tool-mcp"
export const inject = ["pi", "mcp"]

export function apply(ctx: Context): void {
  const search = createToolSearchExtension()
  let stopSearch: (() => void) | undefined

  /** `tool_search` is offered only while there is a deferred tool to find; with none it could only answer "no match". */
  const publish = (): void => {
    const tools = [...ctx.mcp.tools()]
    ctx.pi.install(defineExtension({ name: "tool-mcp", tools }))
    if (tools.length === 0) {
      stopSearch?.()
      stopSearch = undefined
      return
    }
    stopSearch ??= ctx.pi.install(search)
  }

  publish()
  ctx.on("mcp/changed", publish)
}
