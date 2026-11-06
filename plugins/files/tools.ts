import { defineExtension } from "@earendil-works/pi-durable"
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools"
import type { Context } from "../../src/kernel/index.ts"

export const name = "tool-files"
export const inject = ["pi", "files"]

export function apply(ctx: Context): void {
  ctx.pi.env((target) => ctx.files.env(target))
  ctx.pi.install(
    defineExtension({
      name: "tool-files",
      tools: [createReadTool(), createWriteTool(), createEditTool()],
    }),
  )
}
