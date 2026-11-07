import { rowId } from "../../src/contributions.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "mcp-server"
export const inject = ["mcp", "secrets"]

export const Config = Schema.object({
  name: Schema.string()
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .required()
    .description("The server name used in tool names, mcp__<name>__<tool>."),
  url: Schema.string().required().description("The server's https URL."),
  headers: Schema.array(Schema.string()).description("Header names whose values come from this row's secrets."),
})

type Config = {
  readonly name: string
  readonly url: string
  readonly headers: readonly string[]
}

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const row = rowId(ctx)
  const headers: Record<string, string> = {}
  for (const key of config.headers) {
    const value = ctx.secrets.get(key)
    if (value === undefined) throw new Error(`no secret "${key}" is set for row ${row}`)
    headers[key] = value
  }
  return ctx.mcp.connect(
    { name: config.name, url: config.url, ...(Object.keys(headers).length === 0 ? {} : { headers }) },
    row,
  )
}
