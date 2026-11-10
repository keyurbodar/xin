import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai"
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MCP_MODEL, script } from "../../test/plugins/mcp.ts"
import { cmd, fresh, recordOffers, rowState, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const HEADERS = { "content-type": "application/json", "mcp-session-id": "fake-session" }

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
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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
      return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] }
    }
    default:
      throw new Error(`unknown method ${method}`)
  }
}

const serve = (): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 200 })
    const body: unknown = JSON.parse(String(init?.body))
    if (!isRecord(body)) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad body" } })
    const method = typeof body.method === "string" ? body.method : ""
    if (body.id === undefined) return new Response(null, { status: 202 })
    let answer: unknown
    try {
      answer = { result: respond(method, isRecord(body.params) ? body.params : {}) }
    } catch (error) {
      answer = { error: { code: -32601, message: error instanceof Error ? error.message : String(error) } }
    }
    return json({ jsonrpc: "2.0", id: body.id, ...(isRecord(answer) ? answer : {}) })
  })
}

const lastToolResult = async (stub: DurableObjectStub<Home>): Promise<{ isError: boolean; text: string } | undefined> =>
  runInDurableObject(stub, async (home: Home) => {
    const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)
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

const callTool =
  (name: string, args: Record<string, string>): FauxResponseFactory =>
  () =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })

afterEach(() => vi.restoreAllMocks())

describe("tool-mcp row", () => {
  it("offers the mcp tools only while tool-mcp is active, and leaves the mcp service running", async () => {
    const stub = fresh()
    serve()
    const offers = recordOffers()

    expect(await cmd(stub, "row-add", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      ok: true,
      result: { name: "demo", tools: 1 },
    })

    script([
      offers.wrap(callTool("tool_search", { query: "echo" })),
      offers.wrap(callTool("mcp__demo__echo", { text: "hi" })),
      offers.step("done"),
    ])
    await turn(stub, "row-turn-1", { text: "say hi through mcp", model: MCP_MODEL })

    expect(offers.at(0).tools).toContain("tool_search")
    expect(offers.at(0).tools).not.toContain("mcp__demo__echo")
    expect(offers.at(1).tools).toContain("mcp__demo__echo")
    expect(await lastToolResult(stub)).toEqual({ isError: false, text: "echo:hi" })

    expect(await cmd(stub, "row-disable", "plugin.enable", { id: "tool-mcp", enabled: false })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "disabled" } } },
    })
    expect(await rowState(stub, "mcp")).toEqual({ kind: "active" })
    expect(await rowState(stub, "tool-mcp")).toEqual({ kind: "disabled" })
    expect((await cmd(stub, "row-list", "mcp.list")).result).toEqual([
      expect.objectContaining({ name: "demo", tools: 1 }),
    ])

    offers.seen.length = 0
    script([offers.step("no tools for me")])
    await turn(stub, "row-turn-2", { text: "what can you do now", model: MCP_MODEL })

    expect(offers.at(0).tools).not.toContain("tool_search")
    expect(offers.at(0).tools).not.toContain("mcp__demo__echo")

    expect(await cmd(stub, "row-enable", "plugin.enable", { id: "tool-mcp", enabled: true })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "active" } } },
    })

    offers.seen.length = 0
    script([
      offers.wrap(callTool("tool_search", { query: "echo" })),
      offers.wrap(callTool("mcp__demo__echo", { text: "again" })),
      offers.step("done"),
    ])
    await turn(stub, "row-turn-3", { text: "say hi again", model: MCP_MODEL })

    expect(offers.at(0).tools).toContain("tool_search")
    expect(offers.at(1).tools).toContain("mcp__demo__echo")
    expect(await lastToolResult(stub)).toEqual({ isError: false, text: "echo:again" })
  }, 30_000)
})

describe("tool_search without a deferred tool", () => {
  it("offers no search tool while no server has connected, and offers it once one has", async () => {
    const stub = fresh()
    serve()
    const offers = recordOffers()

    script([offers.step("nothing to find")])
    await turn(stub, "search-empty", { text: "find something", model: MCP_MODEL })
    expect(offers.at(0).tools).not.toContain("tool_search")

    expect(await cmd(stub, "search-add", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      ok: true,
      result: { name: "demo", tools: 1 },
    })

    offers.seen.length = 0
    script([offers.step("found it")])
    await turn(stub, "search-full", { text: "find something again", model: MCP_MODEL })
    expect(offers.at(0).tools).toContain("tool_search")
  }, 30_000)
})
