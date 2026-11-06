import {
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
  type CallToolResult,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp"
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable"
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search"
import { arr, compile, map, obj, opt, str, unknown, type Static } from "@earendil-works/pi-schema"
import { jobTool } from "./jobs.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import { defineOp, OpRejected, type Op } from "./ops.ts"
import { Sealer, SealedSchema, type Sealed } from "./seal.ts"

const NAME_SOURCE = "^[a-z0-9]+(?:-[a-z0-9]+)*$"
const URL_SOURCE = "^https://\\S+$"
const SERVER_KEY = "mcp:"
const MAX_TOOL_NAME = 64
const CLIENT = { name: "xin", version: "0.1.0" } as const

const CachedToolSchema = obj({
  name: str({ minLength: 1 }),
  description: str(),
  inputSchema: unknown(),
})
const ServerSchema = obj({
  url: str({ minLength: 1, pattern: URL_SOURCE }),
  headers: opt(SealedSchema),
  tools: arr(CachedToolSchema),
  error: opt(str()),
})
type StoredServer = Static<typeof ServerSchema>
type StoredTool = Static<typeof CachedToolSchema>
const serverCheck = compile(ServerSchema)
const headersCheck = compile(map(str()))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const toolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME)

const parametersOf = (inputSchema: unknown): Record<string, unknown> => {
  const schema = isRecord(inputSchema) ? inputSchema : {}
  const properties = isRecord(schema.properties) ? schema.properties : {}
  return { ...schema, type: "object", properties }
}

const displayUrl = (raw: string): string => {
  const url = new URL(raw)
  return `${url.origin}${url.pathname}`
}

const hideQuery = (text: string, raw: string): string => {
  const query = new URL(raw).search
  return query === "" ? text : text.split(query).join("")
}

const decodeServer = (raw: string): StoredServer | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  return serverCheck.check(value) ? value : undefined
}

const cacheTool = (tool: McpTool): StoredTool => ({
  name: tool.name,
  description: tool.description ?? tool.title ?? tool.name,
  inputSchema: tool.inputSchema,
})

const label = (name: string): string => `${SERVER_KEY}${name}`

const summarize = (name: string, server: StoredServer) => ({
  name,
  url: displayUrl(server.url),
  tools: server.tools.length,
  ...(server.error === undefined ? {} : { error: server.error }),
})

type Row = { readonly name: string; readonly raw: string }

export function create(deps: ModuleDeps): HostModule {
  const sealer = new Sealer(deps.env.KEK)
  const definitions = new Map<string, readonly ToolRegistration[]>()
  let dispose: (() => void) | undefined

  const publish = (): void => {
    const byName = new Map<string, ToolRegistration>()
    const sorted = [...definitions.entries()].toSorted(([left], [right]) => left.localeCompare(right))
    for (const [, tools] of sorted) for (const tool of tools) if (!byName.has(tool.name)) byName.set(tool.name, tool)
    dispose?.()
    dispose = deps.install(defineExtension({ name: "mcp", tools: [...byName.values()] }))
  }

  const rows = async (): Promise<readonly Row[]> => {
    const found = await deps.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM kv WHERE key LIKE ?",
      `${SERVER_KEY}%`,
    )
    return found
      .map((row) => ({ name: row.key.slice(SERVER_KEY.length), raw: row.value }))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  const readRaw = async (name: string): Promise<string | undefined> => {
    const row = await deps.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", label(name))
    return row?.value
  }

  const readServer = async (name: string): Promise<StoredServer | undefined> => {
    const raw = await readRaw(name)
    return raw === undefined ? undefined : decodeServer(raw)
  }

  const writeServer = async (name: string, server: StoredServer): Promise<void> => {
    await deps.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      label(name),
      JSON.stringify(server),
    )
  }

  const replaceServer = async (name: string, expected: string, next: StoredServer): Promise<boolean> => {
    const changed = await deps.db.runCounted(
      "UPDATE kv SET value = ? WHERE key = ? AND value = ?",
      JSON.stringify(next),
      label(name),
      expected,
    )
    return changed === 1
  }

  const headersOf = async (name: string, sealed: Sealed): Promise<Record<string, string>> => {
    const value: unknown = JSON.parse(await sealer.unseal(sealed, label(name)))
    if (!headersCheck.check(value)) throw new Error(`headers of MCP server "${name}" are corrupt`)
    return value
  }

  const withClient = async <T>(
    name: string,
    server: StoredServer,
    run: (client: McpClient) => Promise<T>,
  ): Promise<T> => {
    const headers = server.headers === undefined ? undefined : await headersOf(name, server.headers)
    const client = new McpClient(CLIENT)
    try {
      await client.connect(
        new StreamableHttpTransport({
          url: server.url,
          openGetStream: false,
          ...(headers === undefined ? {} : { headers }),
        }),
      )
      return await run(client)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  const callTool = async (
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> => {
    const server = await readServer(name)
    if (server === undefined) throw new Error(`MCP server "${name}" is not configured`)
    return withClient(name, server, (client) =>
      client.callTool(tool, args, signal === undefined ? undefined : { signal }),
    )
  }

  const register = (name: string, cached: readonly StoredTool[]): void => {
    definitions.set(
      name,
      cached.map((tool) =>
        jobTool(
          {
            name: toolName(name, tool.name),
            description: tool.description,
            parameters: parametersOf(tool.inputSchema),
            deferred: true,
          },
          async (args, run) => {
            const result = await callTool(name, tool.name, args, run.signal)
            return { output: toLlmContent(result), isError: result.isError === true }
          },
        ),
      ),
    )
    publish()
  }

  const unregister = (name: string): void => {
    if (!definitions.delete(name)) return
    publish()
  }

  const refresh = async (name: string): Promise<StoredServer | undefined> => {
    const raw = await readRaw(name)
    if (raw === undefined) return undefined
    const server = decodeServer(raw)
    if (server === undefined) return undefined
    let next: StoredServer
    let listed: StoredTool[] | undefined
    try {
      const tools = await withClient(name, server, (client) => client.listTools())
      listed = tools.map(cacheTool)
      next = {
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
        tools: listed,
      }
    } catch (error) {
      next = { ...server, error: hideQuery(messageOf(error), server.url) }
    }
    if (!(await replaceServer(name, raw, next))) return undefined
    if (listed !== undefined) register(name, listed)
    return next
  }

  const refreshAll = async (names: readonly string[]): Promise<void> => {
    for (const name of names) await refresh(name)
  }

  const add: Op = defineOp({
    name: "mcp.add",
    args: obj({
      name: str({ pattern: NAME_SOURCE }),
      url: str({ pattern: URL_SOURCE }),
      headers: opt(map(str())),
    }),
    actors: ["owner"],
    run: async (_api, { name, url, headers }) => {
      let absolute: URL
      try {
        absolute = new URL(url)
      } catch {
        throw new OpRejected("bad_args", `"${url}" is not a valid URL`)
      }
      if (absolute.username !== "" || absolute.password !== "")
        throw new OpRejected("bad_args", "MCP server URLs may not carry credentials; send them as headers")
      const sealed = headers === undefined ? undefined : await sealer.seal(JSON.stringify(headers), label(name))
      await writeServer(name, {
        url: absolute.toString(),
        ...(sealed === undefined ? {} : { headers: sealed }),
        tools: [],
      })
      unregister(name)
      const server = await refresh(name)
      if (server === undefined) throw new Error(`MCP server "${name}" disappeared while adding it`)
      return summarize(name, server)
    },
  })

  const remove: Op = defineOp({
    name: "mcp.remove",
    args: obj({ name: str({ pattern: NAME_SOURCE }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      await deps.db.run("DELETE FROM kv WHERE key = ?", label(name))
      unregister(name)
      return { name }
    },
  })

  const list: Op = defineOp({
    name: "mcp.list",
    args: obj({}),
    actors: ["owner"],
    run: async () =>
      (await rows()).map((row) => {
        const server = decodeServer(row.raw)
        return server === undefined ? { name: row.name, error: "corrupt" } : summarize(row.name, server)
      }),
  })

  const extension: Extension = defineExtension({ name: "mcp" })

  return {
    extensions: [createToolSearchExtension(), extension],
    ops: [add, remove, list],
    start: async () => {
      const names: string[] = []
      for (const row of await rows()) {
        const server = decodeServer(row.raw)
        if (server === undefined) continue
        names.push(row.name)
        register(row.name, server.tools)
      }
      void refreshAll(names).catch(() => undefined)
    },
  }
}
