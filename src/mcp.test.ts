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
import { MCP_MODEL, requests, script } from "../test/plugins/mcp.ts"
import { fresh } from "../test/support.ts"
import type { Home } from "../test/worker.ts"

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
  during?: () => Promise<void>
}

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const HEADERS = { "content-type": "application/json", "mcp-session-id": "fake-session" }

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: HEADERS })

function respond(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
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
    default:
      throw new Error(`unknown method ${method}`)
  }
}

function fakeServer(): FakeServer {
  const calls: Call[] = []
  const server: FakeServer = {
    calls,
    offline: false,
    holdList: false,
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
      let reply: unknown
      try {
        reply = { result: respond(method, isRecord(body.params) ? body.params : {}) }
      } catch (error) {
        reply = { error: { code: -32601, message: messageOf(error) } }
      }
      return json({ jsonrpc: "2.0", id: body.id, ...(isRecord(reply) ? reply : {}) })
    },
  }
  return server
}

const serve = (fake: FakeServer) => vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch)

type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const cmd = (stub: DurableObjectStub<Home>, id: string, op: string, args?: unknown) =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function turn(stub: DurableObjectStub<Home>, id: string, text: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(MCP_MODEL)
    await home.submit(text, id)
    await home.harness.waitForIdle(context)
  })
}

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
    await turn(stub, "mcp-turn-1", "say hi through mcp")

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
    await turn(stub, "mcp-turn-2", "which tools are cached")

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
    await turn(stub, "mcp-turn-3", "use the good server")

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
    await turn(stub, "mcp-turn-4", "any mcp tools left")

    expect(offered(requestAt(1))).not.toContain("mcp__gone__echo")
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
    await turn(stub, "mcp-turn-5", "any mcp tools left")

    expect(offered(requestAt(1))).not.toContain("mcp__demo__echo")
  })
})
