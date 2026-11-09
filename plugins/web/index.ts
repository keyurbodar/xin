import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import { createTools } from "./web.ts"

export const name = "tool-web"
export const inject = ["pi", "jobs"]

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name: "tool-web", tools: createTools(ctx.jobs) }))
}
