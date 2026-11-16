import { defineExtension } from "@earendil-works/pi-durable"
import type { Context } from "../../src/kernel/index.ts"
import { createTools, SEARCH_KEY_REF } from "./web.ts"

export const name = "tool-web"
export const inject = ["pi", "jobs", "secrets"]

export function apply(ctx: Context): void {
  const publish = (): void => {
    ctx.pi.install(defineExtension({ name: "tool-web", tools: createTools(ctx.jobs, ctx.secrets.get(SEARCH_KEY_REF)) }))
  }

  publish()
  ctx.on("credentials/updated", (ref) => {
    if (ref === SEARCH_KEY_REF) publish()
  })
}
