import { credentialRefsIn, expandAll, waitingCredentials } from "../../src/credentials.ts"
import { rowId } from "../../src/contributions.ts"
import { messageOf } from "../../src/errors.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "mcp-server"
export const inject = ["mcp", "secrets"]

export const Config = Schema.object({
  name: Schema.string()
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .required()
    .description("The server name used in tool names, mcp__<name>__<tool>."),
  url: Schema.string().required().description("The server's https URL. May contain ${credential:REF}."),
  headers: Schema.dict(Schema.string()).description("Request headers; values may contain ${credential:REF}."),
})

type Config = {
  readonly name: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const entries = Object.entries(config.headers ?? {})
  const texts = [config.url, ...entries.map(([, value]) => value)]
  const refs = new Set(texts.flatMap(credentialRefsIn))
  let connection: (() => void) | undefined

  const disconnect = (): void => {
    connection?.()
    connection = undefined
  }

  const attempt = async (): Promise<void> => {
    disconnect()
    const expanded = expandAll(texts, ctx.secrets)
    if (expanded.kind === "missing") {
      ctx.logger.warn(`mcp-server ${config.name}: ${waitingCredentials(expanded.refs)}`)
      return
    }
    const [url, ...values] = expanded.texts
    if (url === undefined) throw new Error(`mcp-server ${config.name}: the url resolved to nothing`)
    const headers: Record<string, string> = {}
    entries.forEach(([header], index) => {
      const value = values[index]
      if (value !== undefined) headers[header] = value
    })
    connection = await ctx.mcp.connect(
      { name: config.name, url, ...(Object.keys(headers).length === 0 ? {} : { headers }) },
      rowId(ctx),
    )
  }

  const listener = ctx.on("credentials/updated", (ref) => {
    if (!refs.has(ref)) return
    void attempt().catch((error: unknown) => {
      ctx.logger.warn(`mcp-server ${config.name}: ${messageOf(error)}`)
    })
  })

  await attempt()
  return () => {
    listener()
    disconnect()
  }
}
