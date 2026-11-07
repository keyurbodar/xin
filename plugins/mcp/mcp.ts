import {
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
  type CallToolResult,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp"
import { type ToolRegistration } from "@earendil-works/pi-durable"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { arr, compile, map, obj, opt, str, unknown, type Static } from "@earendil-works/pi-schema"
import { createContributions } from "../../src/contributions.ts"
import type { JobsService } from "../../src/contracts/jobs.ts"
import type { McpServerContribution, McpService } from "../../src/contracts/mcp.ts"
import type { Env } from "../../src/env.ts"
import { messageOf } from "../../src/errors.ts"
import { defineOp, OpRejected, type Op } from "../../src/ops.ts"
import { Sealer, SealedSchema, type Sealed } from "../../src/seal.ts"

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

const serverUrl = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid URL`)
  }
  if (url.protocol !== "https:") throw new Error(`MCP server URLs must be https, not ${url.protocol.slice(0, -1)}`)
  if (url.username !== "" || url.password !== "")
    throw new Error("MCP server URLs may not carry credentials; send them as headers")
  return url
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

type Connection = {
  readonly name: string
  readonly url: string
  readonly tools: readonly StoredTool[]
  readonly registrations: readonly ToolRegistration[]
  readonly error: string | undefined
}

type Ownership =
  | { readonly kind: "none" }
  | { readonly kind: "stored" }
  | { readonly kind: "row"; readonly source: string }

export type McpPorts = {
  readonly env: Env
  readonly db: SqliteDatabase
  readonly jobs: JobsService
  changed(): void
}

export type McpModule = {
  readonly service: McpService
  readonly ops: readonly Op[]
  start(): Promise<void>
}

async function withConnection<T>(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  run: (client: McpClient) => Promise<T>,
): Promise<T> {
  const client = new McpClient(CLIENT)
  try {
    await client.connect(
      new StreamableHttpTransport({
        url,
        openGetStream: false,
        ...(headers === undefined ? {} : { headers: { ...headers } }),
      }),
    )
    return await run(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

export function create(ports: McpPorts): McpModule {
  const sealer = new Sealer(ports.env.KEK)
  const definitions = new Map<string, readonly ToolRegistration[]>()
  const contributed = createContributions<Connection>({
    key: (connection) => connection.name,
    label: (name) => `MCP server "${name}"`,
  })

  const tools = (): readonly ToolRegistration[] => {
    const sets = new Map<string, readonly ToolRegistration[]>()
    for (const connection of contributed.values()) sets.set(connection.name, connection.registrations)
    for (const [name, registered] of definitions) sets.set(name, registered)
    const byName = new Map<string, ToolRegistration>()
    for (const [, registered] of [...sets.entries()].toSorted(([left], [right]) => left.localeCompare(right)))
      for (const tool of registered) if (!byName.has(tool.name)) byName.set(tool.name, tool)
    return [...byName.values()]
  }

  const changed = (): void => {
    ports.changed()
  }

  const rows = async (): Promise<readonly Row[]> => {
    const found = await ports.db.all<{ key: string; value: string }>(
      "SELECT key, value FROM kv WHERE key LIKE ?",
      `${SERVER_KEY}%`,
    )
    return found
      .map((row) => ({ name: row.key.slice(SERVER_KEY.length), raw: row.value }))
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  const readRaw = async (name: string): Promise<string | undefined> => {
    const row = await ports.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", label(name))
    return row?.value
  }

  const readServer = async (name: string): Promise<StoredServer | undefined> => {
    const raw = await readRaw(name)
    return raw === undefined ? undefined : decodeServer(raw)
  }

  const ownerOf = async (name: string): Promise<Ownership> => {
    const row = contributed.get(name)
    if (row !== undefined) return { kind: "row", source: row.source }
    return (await readRaw(name)) === undefined ? { kind: "none" } : { kind: "stored" }
  }

  const writeServer = async (name: string, server: StoredServer): Promise<void> => {
    await ports.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      label(name),
      JSON.stringify(server),
    )
  }

  const replaceServer = async (name: string, expected: string, next: StoredServer): Promise<boolean> => {
    const updated = await ports.db.runCounted(
      "UPDATE kv SET value = ? WHERE key = ? AND value = ?",
      JSON.stringify(next),
      label(name),
      expected,
    )
    return updated === 1
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
    return withConnection(server.url, headers, run)
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
    const jobs = ports.jobs
    definitions.set(
      name,
      cached.map((tool) =>
        jobs.tool(
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
    changed()
  }

  const unregister = (name: string): void => {
    if (!definitions.delete(name)) return
    changed()
  }

  const refresh = async (name: string): Promise<StoredServer | undefined> => {
    const raw = await readRaw(name)
    if (raw === undefined) return undefined
    const server = decodeServer(raw)
    if (server === undefined) return undefined
    let next: StoredServer
    let listed: StoredTool[] | undefined
    try {
      const fetched = await withClient(name, server, (client) => client.listTools())
      listed = fetched.map(cacheTool)
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

  const connect = async (server: McpServerContribution, source: string): Promise<() => void> => {
    const url = serverUrl(server.url).toString()
    const owner = await ownerOf(server.name)
    switch (owner.kind) {
      case "stored":
        throw new Error(`an MCP server named "${server.name}" is already stored; remove it or rename this row`)
      case "row":
        throw new Error(
          `an MCP server named "${server.name}" is already contributed by ${owner.source}; rename this row`,
        )
      case "none":
        break
    }
    const headers = server.headers
    let cached: readonly StoredTool[] = []
    let error: string | undefined
    try {
      const listed = await withConnection(url, headers, (client) => client.listTools())
      cached = listed.map(cacheTool)
    } catch (caught) {
      error = hideQuery(messageOf(caught), url)
    }
    const jobs = ports.jobs
    const registrations = cached.map((tool) =>
      jobs.tool(
        {
          name: toolName(server.name, tool.name),
          description: tool.description,
          parameters: parametersOf(tool.inputSchema),
          deferred: true,
        },
        async (args, run) => {
          const result = await withConnection(url, headers, (client) =>
            client.callTool(tool.name, args, run.signal === undefined ? undefined : { signal: run.signal }),
          )
          return { output: toLlmContent(result), isError: result.isError === true }
        },
      ),
    )
    const connection: Connection = { name: server.name, url, tools: cached, registrations, error }
    const remove = contributed.add(source, connection)
    changed()
    return () => {
      remove()
      changed()
    }
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
      const owner = await ownerOf(name)
      if (owner.kind === "row")
        throw new OpRejected("bad_args", `MCP server "${name}" is already contributed by ${owner.source}`)
      let absolute: URL
      try {
        absolute = serverUrl(url)
      } catch (error) {
        throw new OpRejected("bad_args", messageOf(error))
      }
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
      await ports.db.run("DELETE FROM kv WHERE key = ?", label(name))
      unregister(name)
      return { name }
    },
  })

  const list: Op = defineOp({
    name: "mcp.list",
    args: obj({}),
    actors: ["owner"],
    run: async () => {
      const stored = await rows()
      const names = new Set(stored.map((row) => row.name))
      const storedViews = stored.map((row) => {
        const server = decodeServer(row.raw)
        return server === undefined ? { name: row.name, error: "corrupt" } : summarize(row.name, server)
      })
      const contributedViews = contributed.entries().flatMap(({ key, value, source }) =>
        names.has(key)
          ? []
          : [
              {
                name: value.name,
                url: displayUrl(value.url),
                tools: value.tools.length,
                ...(value.error === undefined ? {} : { error: value.error }),
                source,
              },
            ],
      )
      return [...storedViews, ...contributedViews].toSorted((left, right) => left.name.localeCompare(right.name))
    },
  })

  const service: McpService = { tools, connect }

  return {
    service,
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
