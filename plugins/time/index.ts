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

export const toolName = (row: string): string =>
  row === name ? "current_time" : `current_time_${row.replaceAll("-", "_")}`

export const extensionName = (row: string): string => `tool-${row}`

export function apply(ctx: Context, config: Config): void {
  format(new Date(0), config.timezone)
  const row = ctx.get("loader")?.locate(ctx.fiber) ?? name
  ctx.pi.install(
    defineExtension({
      name: extensionName(row),
      tools: [
        defineTool({
          name: toolName(row),
          description: `Return the current date and time in ${config.timezone}.`,
          parameters: obj({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: format(new Date(), config.timezone) }] }),
        }),
      ],
    }),
  )
}
