import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import { createTools } from "./git.ts"

export const name = "tool-git"
export const inject = ["pi", "secrets"]

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name: "tool-git", tools: createTools({ secrets: ctx.secrets }) }))
}
