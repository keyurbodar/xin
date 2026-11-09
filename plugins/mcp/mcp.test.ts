import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MCP_MODEL, requests, script } from "../../test/plugins/mcp.ts"
import { cmd, eventually, fresh, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type Call = {
  readonly method: string
  readonly headers: Headers
  readonly params: Record<string, unknown>
}

type FakeServer = {
  readonly fetch: typeof fetch
  readonly calls: Call[]
  offline: boolean
  holdList: boolean
  holdCall: boolean
  during?: () => Promise<void>
  duringCall?: () => Promise<void>
}

type Features = { readonly resources: boolean; readonly prompts: boolean }

const TOOLS = [
  {
    name: "echo",
    description: "Echo text back to the caller.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo." } },
      required: ["text"],
    },
  },
  { name: "fail", description: "Always reports a failure.", inputSchema: { type: "object", properties: {} } },
]

const RESOURCES = [{ uri: "memo://welcome", name: "Welcome", description: "A welcome memo", mimeType: "text/plain" }]
const TEMPLATES = [{ uriTemplate: "memo://{id}", name: "Memo" }]
const PROMPTS = [
  {
    name: "greet",
    description: "Greet someone.",
    arguments: [{ name: "who", description: "Person to greet", required: true }],
  },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const HEADERS = { "content-type": "application/json", "mcp-session-id": "fake-session" }

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: HEADERS })

function respond(method: string, params: Record<string, unknown>, features: Features): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          ...(features.resources ? { resources: {} } : {}),
          ...(features.prompts ? { prompts: {} } : {}),
        },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      }
    case "ping":
      return {}
    case "tools/list":
      return { tools: TOOLS }
    case "tools/call": {
      const args = isRecord(params.arguments) ? params.arguments : {}
      if (params.name === "echo") return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] }
      if (params.name === "fail") return { content: [{ type: "text", text: "it broke" }], isError: true }
      throw new Error(`unknown tool ${String(params.name)}`)
    }
    case "resources/list":
      return { resources: RESOURCES }
    case "resources/templates/list":
      return { resourceTemplates: TEMPLATES }
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : ""
      if (uri !== "memo://welcome") throw new Error(`unknown resource ${uri}`)
      return { contents: [{ uri, mimeType: "text/plain", text: "welcome resource" }] }
    }
    case "prompts/list":
      return { prompts: PROMPTS }
    case "prompts/get": {
      const args = isRecord(params.arguments) ? params.arguments : {}
      if (params.name !== "greet") throw new Error(`unknown prompt ${String(params.name)}`)
      return {
        description: "Greet someone.",
        messages: [{ role: "user", content: { type: "text", text: `hello ${String(args.who ?? "nobody")}` } }],
      }
    }
    default:
      throw new Error(`unknown method ${method}`)
  }
}

function fakeServer(features: Features = { resources: false, prompts: false }): FakeServer {
  const calls: Call[] = []
  const server: FakeServer = {
    calls,
    offline: false,
    holdList: false,
    holdCall: false,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (server.offline || url.pathname === "/dead") throw new TypeError(`connection refused by ${url.href}`)
      if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 200 })
      const body: unknown = JSON.parse(String(init?.body))
      if (!isRecord(body)) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad body" } })
      const method = typeof body.method === "string" ? body.method : ""
      calls.push({ method, headers: new Headers(init?.headers), params: isRecord(body.params) ? body.params : {} })
      if (body.id === undefined) return new Response(null, { status: 202 })
      if (server.holdList && method === "tools/list") await server.during?.()
      if (server.holdCall && method === "tools/call") await server.duringCall?.()
      let reply: unknown
      try {
        reply = { result: respond(method, isRecord(body.params) ? body.params : {}, features) }
      } catch (error) {
        reply = { error: { code: -32601, message: messageOf(error) } }
      }
      return json({ jsonrpc: "2.0", id: body.id, ...(isRecord(reply) ? reply : {}) })
    },
  }
  return server
}

const serve = (fake: FakeServer) => vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch)

function requestAt(index: number): TranscriptContext {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return request
}

function offered(request: TranscriptContext): readonly string[] {
  return getCurrentSystemMessage(request.messages)?.toolsAdded?.map((tool) => tool.name) ?? []
}

async function lastToolResult(stub: DurableObjectStub<Home>): Promise<{ isError: boolean; text: string } | undefined> {
  return runInDurableObject(stub, async (home: Home) => {
    const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
    let found: { isError: boolean; text: string } | undefined
    for (const entry of page.items)
      for (const message of entry.model ?? [])
        if (message.role === "toolResult")
          found = {
            isError: message.isError,
            text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          }
    return found
  })
}

const jobRows = (home: Home): Promise<{ command_id: string }[]> =>
  home.db.all<{ command_id: string }>("SELECT command_id FROM inbound WHERE kind = 'job' ORDER BY id")

const installedTools = (stub: DurableObjectStub<Home>): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) =>
    [...(home.extension("tool-mcp").tools ?? [])].map((tool) => tool.name).toSorted(),
  )

afterEach(() => vi.restoreAllMocks())

describe("mcp servers", () => {
  it("adds a server, defers its tools, and calls one after tool_search loads it", async () => {
    const stub = fresh()
    const fake = fakeServer()
    serve(fake)

    const added = await cmd(stub, "mcp-add-1", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })
    expect(added).toMatchObject({ ok: true, result: { name: "demo", url: "https://mcp.test/mcp", tools: 2 } })
    expect(await cmd(stub, "mcp-list-1", "mcp.list")).toMatchObject({
      ok: true,
      result: [{ name: "demo", url: "https://mcp.test/mcp", tools: 2 }],
    })

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__demo__echo", { text: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "mcp-turn-1", { text: "say hi through mcp", model: MCP_MODEL })

    expect(offered(requestAt(0))).toContain("tool_search")
    expect(offered(requestAt(0))).not.toContain("mcp__demo__echo")
    expect(offered(requestAt(1))).toContain("mcp__demo__echo")
    expect(await lastToolResult(stub)).toEqual({ isError: false, text: "echo:hi" })
    expect(fake.calls.find((call) => call.method === "tools/call")?.params).toEqual({
      name: "echo",
      arguments: { text: "hi" },
    })
  })

  it("registers the cached tool list after an eviction without reaching the server", async () => {
    const stub = fresh()
    const fake = fakeServer()
    serve(fake)
    await cmd(stub, "mcp-add-2", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })

    fake.offline = true
    await evictDurableObject(stub)

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("found it"),
    ])
    await turn(stub, "mcp-turn-2", { text: "which tools are cached", model: MCP_MODEL })

    expect(offered(requestAt(1))).toContain("mcp__demo__echo")
  })

  it("keeps a broken server isolated from the ones that work", async () => {
    const stub = fresh()
    serve(fakeServer())

    expect(await cmd(stub, "mcp-add-3", "mcp.add", { name: "good", url: "https://mcp.test/mcp" })).toMatchObject({
      ok: true,
      result: { name: "good", tools: 2 },
    })
    expect(await cmd(stub, "mcp-add-4", "mcp.add", { name: "dead", url: "https://mcp.test/dead" })).toMatchObject({
      ok: true,
      result: { name: "dead", tools: 0, error: expect.stringContaining("connection refused") },
    })
    expect((await cmd(stub, "mcp-list-2", "mcp.list")).result).toEqual([
      expect.objectContaining({ name: "dead", tools: 0, error: expect.stringContaining("connection refused") }),
      expect.objectContaining({ name: "good", tools: 2 }),
    ])

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__good__echo", { text: "still here" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "mcp-turn-3", { text: "use the good server", model: MCP_MODEL })

    expect(await lastToolResult(stub)).toEqual({ isError: false, text: "echo:still here" })
  })

  it("stores server headers sealed and sends them on the wire", async () => {
    const stub = fresh()
    const fake = fakeServer()
    serve(fake)

    await cmd(stub, "mcp-add-5", "mcp.add", {
      name: "auth",
      url: "https://mcp.test/mcp",
      headers: { authorization: "Bearer hush-hush" },
    })

    const stored = await runInDurableObject(stub, (home: Home) =>
      home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", "mcp:auth"),
    )
    expect(stored?.value).not.toContain("hush-hush")
    expect(stored?.value).toContain('"iv"')
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer hush-hush")
  })

  it("rejects non-https and credential-bearing URLs and never shows a query string", async () => {
    const stub = fresh()
    serve(fakeServer())

    expect(await cmd(stub, "mcp-add-6", "mcp.add", { name: "plain", url: "http://mcp.test/mcp" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(
      await cmd(stub, "mcp-add-7", "mcp.add", { name: "creds", url: "https://user:pass@mcp.test/mcp" }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })

    expect(
      await cmd(stub, "mcp-add-8", "mcp.add", { name: "dead", url: "https://mcp.test/dead?token=secret" }),
    ).toMatchObject({
      ok: true,
      result: {
        name: "dead",
        url: "https://mcp.test/dead",
        tools: 0,
        error: expect.stringContaining("connection refused"),
      },
    })
    expect(JSON.stringify(await cmd(stub, "mcp-list-3", "mcp.list"))).not.toContain("secret")
  })

  it("shows a corrupt stored server instead of dropping it", async () => {
    const stub = fresh()

    await runInDurableObject(stub, (home: Home) =>
      home.db.run("INSERT INTO kv (key, value) VALUES (?, ?)", "mcp:broken", "{not json"),
    )

    expect((await cmd(stub, "mcp-list-4", "mcp.list")).result).toEqual([{ name: "broken", error: "corrupt" }])
  })

  it("removes a server, its tools and its stored row", async () => {
    const stub = fresh()
    serve(fakeServer())
    await cmd(stub, "mcp-add-9", "mcp.add", { name: "gone", url: "https://mcp.test/mcp" })

    expect(await cmd(stub, "mcp-remove-1", "mcp.remove", { name: "gone" })).toMatchObject({
      ok: true,
      result: { name: "gone" },
    })
    expect((await cmd(stub, "mcp-list-5", "mcp.list")).result).toEqual([])
    expect(
      await runInDurableObject(stub, (home: Home) =>
        home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", "mcp:gone"),
      ),
    ).toBeUndefined()

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("nothing left"),
    ])
    await turn(stub, "mcp-turn-4", { text: "any mcp tools left", model: MCP_MODEL })

    expect(offered(requestAt(1))).not.toContain("mcp__gone__echo")
  })

  it("keeps every server's tools when their synthetic names collide", async () => {
    const stub = fresh()
    serve(fakeServer())
    const one = "a".repeat(60)
    const two = `${"a".repeat(59)}b`
    await cmd(stub, "mcp-collide-1", "mcp.add", { name: one, url: "https://mcp.test/one" })
    await cmd(stub, "mcp-collide-2", "mcp.add", { name: two, url: "https://mcp.test/two" })

    const installed = await runInDurableObject(stub, (home: Home) =>
      [...(home.extension("tool-mcp").tools ?? [])].map((tool) => tool.name),
    )
    expect(installed).toHaveLength(4)
    expect(new Set(installed).size).toBe(4)
  })

  it("leaves exactly the current servers' tools on the mcp extension through add, refresh and remove", async () => {
    const stub = fresh()
    serve(fakeServer())

    await cmd(stub, "mcp-swap-1", "mcp.add", { name: "alpha", url: "https://mcp.test/alpha" })
    await cmd(stub, "mcp-swap-2", "mcp.add", { name: "beta", url: "https://mcp.test/beta" })
    await cmd(stub, "mcp-swap-3", "mcp.add", { name: "alpha", url: "https://mcp.test/alpha" })
    await cmd(stub, "mcp-swap-4", "mcp.remove", { name: "beta" })
    await cmd(stub, "mcp-swap-5", "mcp.add", { name: "gamma", url: "https://mcp.test/gamma" })

    const installed = await runInDurableObject(stub, (home: Home) =>
      [...(home.extension("tool-mcp").tools ?? [])].map((tool) => tool.name).toSorted(),
    )
    expect(installed).toEqual(["mcp__alpha__echo", "mcp__alpha__fail", "mcp__gamma__echo", "mcp__gamma__fail"])
    expect((await cmd(stub, "mcp-swap-list", "mcp.list")).result).toEqual([
      expect.objectContaining({ name: "alpha", tools: 2 }),
      expect.objectContaining({ name: "gamma", tools: 2 }),
    ])
  })

  it("does not resurrect a server removed while its refresh is in flight", async () => {
    const stub = fresh()
    const fake = fakeServer()
    serve(fake)
    await cmd(stub, "mcp-add-10", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })

    const home = await runInDurableObject(stub, (instance: Home) => instance)
    fake.holdList = true
    fake.during = async () => {
      await home.fetch(
        new Request("https://xin.test/v1/cmd", {
          method: "POST",
          body: JSON.stringify({ id: "mcp-remove-2", op: "mcp.remove", args: { name: "demo" } }),
        }),
      )
    }
    expect(await cmd(stub, "mcp-add-11", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      ok: false,
      error: { code: "failed" },
    })

    expect((await cmd(stub, "mcp-list-6", "mcp.list")).result).toEqual([])

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("nothing left"),
    ])
    await turn(stub, "mcp-turn-5", { text: "any mcp tools left", model: MCP_MODEL })

    expect(offered(requestAt(1))).not.toContain("mcp__demo__echo")
  })

  it("turns a held MCP call into a job that reports once", async () => {
    const stub = fresh()
    const fake = fakeServer()
    serve(fake)
    await cmd(stub, "mcp-add-job", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })

    const gate = Promise.withResolvers<void>()
    fake.holdCall = true
    fake.duringCall = () => gate.promise

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__demo__echo", { text: "slow" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "mcp-turn-job", { text: "say hi slowly through mcp", model: MCP_MODEL })

    expect((await lastToolResult(stub))?.text).toMatch(/^started \(job \d+\)/)

    fake.holdCall = false
    gate.resolve()
    await eventually(stub, async (home: Home) => (await jobRows(home)).length === 1)
    const rows = await runInDurableObject(stub, jobRows)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.command_id).toMatch(/^job:\d+$/)
  }, 30_000)

  it("answers a server's cached tools and rejects an unknown name", async () => {
    const stub = fresh()
    serve(fakeServer())
    await cmd(stub, "mcp-tools-add-1", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })
    await cmd(stub, "mcp-tools-add-2", "mcp.add", { name: "dead", url: "https://mcp.test/dead" })

    expect((await cmd(stub, "mcp-tools-1", "mcp.tools", { name: "demo" })).result).toEqual({
      name: "demo",
      tools: [
        { name: "echo", description: "Echo text back to the caller." },
        { name: "fail", description: "Always reports a failure." },
      ],
    })
    expect((await cmd(stub, "mcp-tools-2", "mcp.tools", { name: "dead" })).result).toEqual({
      name: "dead",
      tools: [],
    })
    expect(await cmd(stub, "mcp-tools-3", "mcp.tools", { name: "nope" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: "no MCP server nope" },
    })
  })

  it("lists and reads resources and renders prompts when the server declares them", async () => {
    const stub = fresh()
    const fake = fakeServer({ resources: true, prompts: true })
    serve(fake)

    expect(
      await cmd(stub, "mcp-resources-add", "mcp.add", { name: "docs", url: "https://mcp.test/mcp" }),
    ).toMatchObject({
      ok: true,
      result: { name: "docs", url: "https://mcp.test/mcp", tools: 2, resources: 1, templates: 1, prompts: 1 },
    })
    expect(await installedTools(stub)).toEqual([
      "mcp__docs__echo",
      "mcp__docs__fail",
      "mcp__docs__mcp_prompt",
      "mcp__docs__mcp_prompts",
      "mcp__docs__mcp_resource",
      "mcp__docs__mcp_resources",
    ])
    expect((await cmd(stub, "mcp-resources-op", "mcp.resources", { name: "docs" })).result).toEqual({
      name: "docs",
      resources: [{ uri: "memo://welcome", name: "Welcome", description: "A welcome memo", mimeType: "text/plain" }],
      templates: [{ uriTemplate: "memo://{id}", name: "Memo" }],
    })
    expect((await cmd(stub, "mcp-prompts-op", "mcp.prompts", { name: "docs" })).result).toEqual({
      name: "docs",
      prompts: [
        {
          name: "greet",
          description: "Greet someone.",
          arguments: [{ name: "who", description: "Person to greet", required: true }],
        },
      ],
    })

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp_resources" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__docs__mcp_resources", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp_resource" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__docs__mcp_resource", { uri: "memo://welcome" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp_prompts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__docs__mcp_prompts", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp_prompt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__docs__mcp_prompt", { name: "greet", arguments: { who: "Keyur" } })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "mcp-resources-turn", { text: "read the docs server", model: MCP_MODEL })

    expect(await lastToolResult(stub)).toEqual({ isError: false, text: "user: hello Keyur" })
    expect(fake.calls.find((call) => call.method === "resources/read")?.params).toEqual({ uri: "memo://welcome" })
    expect(fake.calls.find((call) => call.method === "prompts/get")?.params).toEqual({
      name: "greet",
      arguments: { who: "Keyur" },
    })
  }, 30_000)
})
