import { runInDurableObject } from "cloudflare:test"
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MCP_MODEL, requests, script } from "../../test/plugins/mcp.ts"
import { cmd, fresh, rowState, setRow, turn, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Call = {
  readonly method: string
  readonly headers: Headers
  readonly params: Record<string, unknown>
}

type FakeServer = {
  readonly fetch: typeof fetch
  readonly calls: Call[]
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
      return { content: [{ type: "text", text: "it broke" }], isError: true }
    }
    default:
      throw new Error(`unknown method ${method}`)
  }
}

function fakeServer(): FakeServer {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 200 })
      const body: unknown = JSON.parse(String(init?.body))
      if (!isRecord(body)) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad body" } })
      const method = typeof body.method === "string" ? body.method : ""
      calls.push({ method, headers: new Headers(init?.headers), params: isRecord(body.params) ? body.params : {} })
      if (body.id === undefined) return new Response(null, { status: 202 })
      let reply: unknown
      try {
        reply = { result: respond(method, isRecord(body.params) ? body.params : {}) }
      } catch (error) {
        reply = { error: { code: -32601, message: messageOf(error) } }
      }
      return json({ jsonrpc: "2.0", id: body.id, ...(isRecord(reply) ? reply : {}) })
    },
  }
}

const serve = (fake: FakeServer) => vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch)

function offered(request: TranscriptContext): readonly string[] {
  return getCurrentSystemMessage(request.messages)?.toolsAdded?.map((tool) => tool.name) ?? []
}

function requestAt(index: number): TranscriptContext {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return request
}

const installed = (stub: Stub): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) =>
    [...(home.extension("tool-mcp").tools ?? [])].map((tool) => tool.name).toSorted(),
  )

const stored = (stub: Stub, name: string): Promise<{ value: string } | undefined> =>
  runInDurableObject(stub, (home: Home) =>
    home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", `mcp:${name}`),
  )

async function insert(stub: Stub, id: string, config: Record<string, unknown>): Promise<unknown> {
  const ack = await cmd(stub, `insert-${id}`, "plugin.insert", { id, plugin: "mcp-server", config })
  return ack.result
}

afterEach(() => vi.restoreAllMocks())

describe("mcp-server row", () => {
  it("connects a server held by the row, sends its secret header, and leaves the table alone", async () => {
    const stub = fresh()
    const fake = fakeServer()
    serve(fake)

    expect(
      await cmd(stub, "secret-1", "plugin.secret.set", {
        id: "demo-row",
        key: "authorization",
        value: "Bearer row-token",
      }),
    ).toMatchObject({ ok: true })

    expect(
      await insert(stub, "demo-row", {
        name: "demo",
        url: "https://mcp.test/mcp",
        headers: ["authorization"],
      }),
    ).toMatchObject({ application: "applied" })

    expect(await stored(stub, "demo")).toBeUndefined()
    expect((await cmd(stub, "list-1", "mcp.list")).result).toEqual([
      { name: "demo", url: "https://mcp.test/mcp", tools: 2, source: "demo-row" },
    ])
    expect(await installed(stub)).toEqual(["mcp__demo__echo", "mcp__demo__fail"])
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer row-token")

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__demo__echo", { text: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "row-turn-1", { text: "say hi through the row's server", model: MCP_MODEL })

    expect(offered(requestAt(0))).not.toContain("mcp__demo__echo")
    expect(offered(requestAt(1))).toContain("mcp__demo__echo")
    expect(fake.calls.find((call) => call.method === "tools/call")?.headers.get("authorization")).toBe(
      "Bearer row-token",
    )
    expect(fake.calls.find((call) => call.method === "tools/call")?.params).toEqual({
      name: "echo",
      arguments: { text: "hi" },
    })
  }, 20_000)

  it("takes the tools away when the row is disabled", async () => {
    const stub = fresh()
    serve(fakeServer())
    expect(await insert(stub, "demo-row", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      application: "applied",
    })
    expect(await installed(stub)).toContain("mcp__demo__echo")

    await setRow(stub, "demo-row", false)

    expect(await installed(stub)).toEqual([])
    expect((await cmd(stub, "list-disabled", "mcp.list")).result).toEqual([])
  }, 20_000)

  it("fails the row when a stored server already has its name", async () => {
    const stub = fresh()
    serve(fakeServer())
    await cmd(stub, "add-1", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })

    expect(await insert(stub, "demo-row", { name: "demo", url: "https://mcp.test/other" })).toMatchObject({
      application: "failed",
    })
    expect(await rowState(stub, "demo-row")).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("already stored"),
    })
    expect((await cmd(stub, "list-clash", "mcp.list")).result).toEqual([
      expect.objectContaining({ name: "demo", tools: 2 }),
    ])
  }, 20_000)

  it("fails the row when another row already owns the server name", async () => {
    const stub = fresh()
    serve(fakeServer())
    expect(await insert(stub, "row-one", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      application: "applied",
    })

    expect(await insert(stub, "row-two", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      application: "failed",
    })
    expect(await rowState(stub, "row-two")).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("row-one"),
    })
    expect((await cmd(stub, "list-row-clash", "mcp.list")).result).toEqual([
      expect.objectContaining({ name: "demo", tools: 2, source: "row-one" }),
    ])
  }, 20_000)

  it("rejects mcp.add for a name a row owns", async () => {
    const stub = fresh()
    serve(fakeServer())
    expect(await insert(stub, "owner-row", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      application: "applied",
    })

    expect(await cmd(stub, "add-owned", "mcp.add", { name: "demo", url: "https://mcp.test/other" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("owner-row") },
    })
    expect(await stored(stub, "demo")).toBeUndefined()
  }, 20_000)

  it("fails the row on a URL that is not https", async () => {
    const stub = fresh()
    expect(await insert(stub, "demo-row", { name: "demo", url: "http://mcp.test/mcp" })).toMatchObject({
      application: "failed",
    })
    expect(await rowState(stub, "demo-row")).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("https"),
    })
  }, 20_000)
})
