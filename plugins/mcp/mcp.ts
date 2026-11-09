import {
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp"
import { type ToolRegistration } from "@earendil-works/pi-durable"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { arr, bool, compile, int, map, obj, oneOf, opt, str, unknown, type Static } from "@earendil-works/pi-schema"
import { createContributions } from "../../src/contributions.ts"
import type { JobsService } from "../../src/contracts/jobs.ts"
import type { McpServerContribution, McpService } from "../../src/contracts/mcp.ts"
import type { Env } from "../../src/env.ts"
import { messageOf } from "../../src/errors.ts"
import { textResult } from "../../src/kernel/index.ts"
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
const PromptArgumentSchema = obj({
  name: str({ minLength: 1 }),
  description: opt(str()),
  required: opt(bool()),
})
const PromptSchema = obj(
  {
    name: str({ minLength: 1 }),
    title: opt(str()),
    description: opt(str()),
    arguments: opt(arr(PromptArgumentSchema)),
  },
  { open: true },
)
const PromptListSchema = obj({ prompts: arr(PromptSchema), nextCursor: opt(str()) }, { open: true })
const PromptMessageSchema = obj({ role: oneOf(["user", "assistant"] as const), content: unknown() }, { open: true })
const PromptGetSchema = obj({ description: opt(str()), messages: arr(PromptMessageSchema) }, { open: true })
type Prompt = Static<typeof PromptSchema>
type PromptGet = Static<typeof PromptGetSchema>
const promptListCheck = compile(PromptListSchema)
const promptGetCheck = compile(PromptGetSchema)
const ResourceReadArgs = obj({ uri: str({ minLength: 1, maxLength: 2_048 }) })
const PromptGetArgs = obj({ name: str({ minLength: 1, maxLength: 200 }), arguments: opt(map(str())) })
const resourceReadCheck = compile(ResourceReadArgs)
const promptGetArgsCheck = compile(PromptGetArgs)
const ServerSchema = obj({
  url: str({ minLength: 1, pattern: URL_SOURCE }),
  headers: opt(SealedSchema),
  tools: arr(CachedToolSchema),
  resources: opt(bool()),
  prompts: opt(bool()),
  resourceCount: opt(int({ minimum: 0 })),
  templateCount: opt(int({ minimum: 0 })),
  promptCount: opt(int({ minimum: 0 })),
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

function resourceText(value: unknown): string {
  if (!isRecord(value)) return ""
  if (typeof value.text === "string") return value.text
  if (typeof value.blob === "string")
    return `[binary resource: ${String(value.mimeType ?? "unknown")}, ${value.blob.length} base64 chars]`
  return ""
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map(contentText)
      .filter((text) => text !== "")
      .join("\n")
  if (!isRecord(value)) return ""
  if (value.type === "text" && typeof value.text === "string") return value.text
  if (value.type === "image" || value.type === "audio") return `[${value.type}: ${String(value.mimeType ?? "unknown")}]`
  if (value.type === "resource") return resourceText(value.resource)
  if (value.type === "resource_link") return `[resource link: ${String(value.uri ?? "")}]`
  return ""
}

function readText(result: ReadResourceResult): string {
  const text = result.contents.map(resourceText).filter((part) => part !== "")
  return text.length === 0 ? "No content." : text.join("\n\n")
}

async function listPrompts(client: McpClient, signal?: AbortSignal): Promise<Prompt[]> {
  const prompts: Prompt[] = []
  let cursor: string | undefined
  do {
    const value: unknown = await client.request(
      "prompts/list",
      cursor === undefined ? {} : { cursor },
      signal === undefined ? undefined : { signal },
    )
    if (!promptListCheck.check(value)) throw new Error("the server returned an invalid prompt list")
    prompts.push(...value.prompts)
    cursor = value.nextCursor
  } while (cursor !== undefined)
  return prompts
}

function promptText(result: PromptGet): string {
  return result.messages
    .map((message) => `${message.role}: ${contentText(message.content)}`)
    .filter((line) => line !== "")
    .join("\n\n")
}

const resourceView = (resource: Resource) => ({
  uri: resource.uri,
  name: resource.name,
  ...(resource.title === undefined ? {} : { title: resource.title }),
  ...(resource.description === undefined ? {} : { description: resource.description }),
  ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
})

const templateView = (template: ResourceTemplate) => ({
  uriTemplate: template.uriTemplate,
  name: template.name,
  ...(template.title === undefined ? {} : { title: template.title }),
  ...(template.description === undefined ? {} : { description: template.description }),
  ...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
})

const promptView = (prompt: Prompt) => ({
  name: prompt.name,
  ...(prompt.title === undefined ? {} : { title: prompt.title }),
  ...(prompt.description === undefined ? {} : { description: prompt.description }),
  ...(prompt.arguments === undefined
    ? {}
    : {
        arguments: prompt.arguments.map((argument) => ({
          name: argument.name,
          ...(argument.description === undefined ? {} : { description: argument.description }),
          ...(argument.required === undefined ? {} : { required: argument.required }),
        })),
      }),
})

function resourceListText(resources: readonly Resource[], templates: readonly ResourceTemplate[]): string {
  const lines = resources.map((resource) => {
    const mime = resource.mimeType === undefined ? "" : ` (${resource.mimeType})`
    const description = resource.description === undefined ? "" : `: ${resource.description}`
    return `- ${resource.name} <${resource.uri}>${mime}${description}`
  })
  if (templates.length > 0) {
    lines.push("", "Templates:")
    for (const template of templates) {
      const description = template.description === undefined ? "" : `: ${template.description}`
      lines.push(`- ${template.name} <${template.uriTemplate}>${description}`)
    }
  }
  return lines.length === 0 ? "No resources." : lines.join("\n")
}

function promptListText(prompts: readonly Prompt[]): string {
  if (prompts.length === 0) return "No prompts."
  return prompts
    .map((prompt) => {
      const description = prompt.description === undefined ? "" : `: ${prompt.description}`
      const args =
        prompt.arguments === undefined || prompt.arguments.length === 0
          ? ""
          : ` (${prompt.arguments
              .map((argument) => `${argument.name}${argument.required === true ? "" : "?"}`)
              .join(", ")})`
      return `- ${prompt.name}${args}${description}`
    })
    .join("\n")
}

const label = (name: string): string => `${SERVER_KEY}${name}`

const summarize = (name: string, server: StoredServer) => ({
  name,
  url: displayUrl(server.url),
  tools: server.tools.length,
  ...(server.resources === true ? { resources: server.resourceCount ?? 0, templates: server.templateCount ?? 0 } : {}),
  ...(server.prompts === true ? { prompts: server.promptCount ?? 0 } : {}),
  ...(server.error === undefined ? {} : { error: server.error }),
})

type Row = { readonly name: string; readonly raw: string }

type Connection = {
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>> | undefined
  readonly tools: readonly StoredTool[]
  readonly registrations: readonly ToolRegistration[]
  readonly resources: boolean
  readonly prompts: boolean
  readonly resourceCount: number
  readonly templateCount: number
  readonly promptCount: number
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

type Inspection = {
  readonly tools: readonly McpTool[]
  readonly resources: boolean
  readonly prompts: boolean
  readonly resourceCount: number
  readonly templateCount: number
  readonly promptCount: number
}

async function inspectServer(client: McpClient): Promise<Inspection> {
  const tools = await client.listTools()
  const resources = client.serverCapabilities?.resources !== undefined
  const prompts = client.serverCapabilities?.prompts !== undefined
  const [listedResources, templates, listedPrompts] = await Promise.all([
    resources ? client.listResources().catch(() => []) : Promise.resolve([]),
    resources ? client.listResourceTemplates().catch(() => []) : Promise.resolve([]),
    prompts ? listPrompts(client).catch(() => []) : Promise.resolve([]),
  ])
  return {
    tools,
    resources,
    prompts,
    resourceCount: listedResources.length,
    templateCount: templates.length,
    promptCount: listedPrompts.length,
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

  type Target = { readonly url: string; readonly headers: Readonly<Record<string, string>> | undefined }

  const targetOf = async (name: string): Promise<Target | undefined> => {
    const raw = await readRaw(name)
    if (raw === undefined) {
      const connection = contributed.get(name)
      return connection === undefined ? undefined : { url: connection.value.url, headers: connection.value.headers }
    }
    const server = decodeServer(raw)
    if (server === undefined) return undefined
    const headers = server.headers === undefined ? undefined : await headersOf(name, server.headers)
    return { url: server.url, headers }
  }

  const withClient = async <T>(
    name: string,
    server: StoredServer,
    run: (client: McpClient) => Promise<T>,
  ): Promise<T> => {
    const headers = server.headers === undefined ? undefined : await headersOf(name, server.headers)
    return withConnection(server.url, headers, run)
  }

  type McpCall = <T>(run: (client: McpClient) => Promise<T>) => Promise<T>

  const toolSet = (
    name: string,
    call: McpCall,
    cached: readonly StoredTool[],
    resources: boolean,
    prompts: boolean,
  ): readonly ToolRegistration[] => {
    const jobs = ports.jobs
    const baseTools = cached.map((tool) =>
      jobs.tool(
        {
          name: toolName(name, tool.name),
          description: tool.description,
          parameters: parametersOf(tool.inputSchema),
          deferred: true,
        },
        async (args, run) => {
          const result = await call((client) =>
            client.callTool(tool.name, args, run.signal === undefined ? undefined : { signal: run.signal }),
          )
          return { output: toLlmContent(result), isError: result.isError === true }
        },
      ),
    )
    const extra: ToolRegistration[] = []
    if (resources) {
      extra.push(
        jobs.tool(
          {
            name: toolName(name, "mcp_resources"),
            description: `List the resources and resource templates on MCP server "${name}".`,
            parameters: obj({}),
            deferred: true,
          },
          async (_args, run) => {
            const [list, templates] = await call((client) =>
              Promise.all([
                client.listResources({ signal: run.signal }),
                client.listResourceTemplates({ signal: run.signal }),
              ]),
            )
            return textResult(resourceListText(list, templates), {
              details: { resources: list.map(resourceView), templates: templates.map(templateView) },
            })
          },
        ),
        jobs.tool(
          {
            name: toolName(name, "mcp_resource"),
            description: `Read one resource from MCP server "${name}" by URI.`,
            parameters: ResourceReadArgs,
            deferred: true,
          },
          async (args, run) => {
            if (!resourceReadCheck.check(args)) return textResult("mcp_resource needs a uri", { isError: true })
            const result = await call((client) => client.readResource(args.uri, { signal: run.signal }))
            return textResult(readText(result), { details: { uri: args.uri } })
          },
        ),
      )
    }
    if (prompts) {
      extra.push(
        jobs.tool(
          {
            name: toolName(name, "mcp_prompts"),
            description: `List the prompts on MCP server "${name}".`,
            parameters: obj({}),
            deferred: true,
          },
          async (_args, run) => {
            const list = await call((client) => listPrompts(client, run.signal))
            return textResult(promptListText(list), { details: { prompts: list.map(promptView) } })
          },
        ),
        jobs.tool(
          {
            name: toolName(name, "mcp_prompt"),
            description: `Render a prompt from MCP server "${name}" with its arguments.`,
            parameters: PromptGetArgs,
            deferred: true,
          },
          async (args, run) => {
            if (!promptGetArgsCheck.check(args)) return textResult("mcp_prompt needs a name", { isError: true })
            const value: unknown = await call((client) =>
              client.request(
                "prompts/get",
                { name: args.name, arguments: args.arguments ?? {} },
                { signal: run.signal },
              ),
            )
            if (!promptGetCheck.check(value))
              return textResult("the server returned an invalid prompt", { isError: true })
            return textResult(promptText(value), {
              details: {
                name: args.name,
                ...(value.description === undefined ? {} : { description: value.description }),
              },
            })
          },
        ),
      )
    }
    return [...baseTools, ...extra]
  }

  const register = (
    name: string,
    server: StoredServer,
    cached: readonly StoredTool[],
    resources: boolean,
    prompts: boolean,
  ): void => {
    definitions.set(
      name,
      toolSet(name, (run) => withClient(name, server, run), cached, resources, prompts),
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
      const fetched = await withClient(name, server, inspectServer)
      listed = fetched.tools.map(cacheTool)
      next = {
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
        tools: listed,
        resources: fetched.resources,
        prompts: fetched.prompts,
        ...(fetched.resources ? { resourceCount: fetched.resourceCount, templateCount: fetched.templateCount } : {}),
        ...(fetched.prompts ? { promptCount: fetched.promptCount } : {}),
      }
    } catch (error) {
      next = { ...server, error: hideQuery(messageOf(error), server.url) }
    }
    if (!(await replaceServer(name, raw, next))) return undefined
    if (listed !== undefined) register(name, next, listed, next.resources === true, next.prompts === true)
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
    let inspection: Inspection | undefined
    let error: string | undefined
    try {
      inspection = await withConnection(url, headers, inspectServer)
      cached = inspection.tools.map(cacheTool)
    } catch (caught) {
      error = hideQuery(messageOf(caught), url)
    }
    const call: McpCall = (run) => withConnection(url, headers, run)
    const registrations = toolSet(
      server.name,
      call,
      cached,
      inspection?.resources === true,
      inspection?.prompts === true,
    )
    const connection: Connection = {
      name: server.name,
      url,
      headers,
      tools: cached,
      registrations,
      resources: inspection?.resources === true,
      prompts: inspection?.prompts === true,
      resourceCount: inspection?.resourceCount ?? 0,
      templateCount: inspection?.templateCount ?? 0,
      promptCount: inspection?.promptCount ?? 0,
      error,
    }
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
                ...(value.resources ? { resources: value.resourceCount, templates: value.templateCount } : {}),
                ...(value.prompts ? { prompts: value.promptCount } : {}),
                ...(value.error === undefined ? {} : { error: value.error }),
                source,
              },
            ],
      )
      return [...storedViews, ...contributedViews].toSorted((left, right) => left.name.localeCompare(right.name))
    },
  })

  const read: Op = defineOp({
    name: "mcp.tools",
    args: obj({ name: str({ pattern: NAME_SOURCE }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      const raw = await readRaw(name)
      const cached = raw !== undefined ? (decodeServer(raw)?.tools ?? []) : contributed.get(name)?.value.tools
      if (cached === undefined) throw new OpRejected("bad_args", `no MCP server ${name}`)
      return { name, tools: cached.map((tool) => ({ name: tool.name, description: tool.description })) }
    },
  })

  const resources: Op = defineOp({
    name: "mcp.resources",
    args: obj({ name: str({ pattern: NAME_SOURCE }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      const target = await targetOf(name)
      if (target === undefined) throw new OpRejected("bad_args", `no MCP server ${name}`)
      const [found, templates] = await withConnection(target.url, target.headers, (client) =>
        Promise.all([client.listResources(), client.listResourceTemplates()]),
      )
      return { name, resources: found.map(resourceView), templates: templates.map(templateView) }
    },
  })

  const prompts: Op = defineOp({
    name: "mcp.prompts",
    args: obj({ name: str({ pattern: NAME_SOURCE }) }),
    actors: ["owner"],
    run: async (_api, { name }) => {
      const target = await targetOf(name)
      if (target === undefined) throw new OpRejected("bad_args", `no MCP server ${name}`)
      const found = await withConnection(target.url, target.headers, (client) => listPrompts(client))
      return { name, prompts: found.map(promptView) }
    },
  })

  const service: McpService = { tools, connect }

  return {
    service,
    ops: [add, remove, list, read, resources, prompts],
    start: async () => {
      const names: string[] = []
      for (const row of await rows()) {
        const server = decodeServer(row.raw)
        if (server === undefined) continue
        names.push(row.name)
        register(row.name, server, server.tools, server.resources === true, server.prompts === true)
      }
      void refreshAll(names).catch(() => undefined)
    },
  }
}
