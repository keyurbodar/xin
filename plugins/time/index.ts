import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "time"
export const inject = ["pi"]
export const Config = Schema.object({
  timezone: Schema.string().default("UTC").description("IANA timezone, for example Europe/Berlin."),
})

type Config = { readonly timezone: string }

export function format(now: Date, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now)
  return `${local} (${timezone}, ${now.toISOString()})`
}

export function apply(ctx: Context, config: Config): void {
  format(new Date(0), config.timezone)
  ctx.pi.install(
    defineExtension({
      name: "time",
      tools: [
        defineTool({
          name: "current_time",
          description: "Return the current date and time in the owner's timezone.",
          parameters: obj({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: format(new Date(), config.timezone) }] }),
        }),
      ],
    }),
  )
}
