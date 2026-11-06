import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai"
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MCP_MODEL, requests, script } from "../../test/plugins/mcp.ts"
import { fresh } from "../../test/support.ts"
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
    let reply: unknown
    try {
      reply = { result: respond(method, isRecord(body.params) ? body.params : {}) }
    } catch (error) {
      reply = { error: { code: -32601, message: error instanceof Error ? error.message : String(error) } }
    }
    return json({ jsonrpc: "2.0", id: body.id, ...(isRecord(reply) ? reply : {}) })
  })
}

type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const cmd = (stub: DurableObjectStub<Home>, id: string, op: string, args: unknown = {}) =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function turn(stub: DurableObjectStub<Home>, id: string, text: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(MCP_MODEL)
    await home.submit(text, id)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
  })
}

const offered = (index: number): readonly string[] => {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return getCurrentSystemMessage(request.messages)?.toolsAdded?.map((tool) => tool.name) ?? []
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const rowState = async (stub: DurableObjectStub<Home>, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}`, "plugin.list")
  if (!Array.isArray(listed.result)) throw new Error("plugin.list did not return rows")
  return field(
    listed.result.find((row) => field(row, "id") === id),
    "state",
  )
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

afterEach(() => vi.restoreAllMocks())

describe("tool-mcp row", () => {
  it("offers the mcp tools only while tool-mcp is active, and leaves the mcp service running", async () => {
    const stub = fresh()
    serve()

    expect(await cmd(stub, "row-add", "mcp.add", { name: "demo", url: "https://mcp.test/mcp" })).toMatchObject({
      ok: true,
      result: { name: "demo", tools: 1 },
    })

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__demo__echo", { text: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "row-turn-1", "say hi through mcp")

    expect(offered(0)).toContain("tool_search")
    expect(offered(0)).not.toContain("mcp__demo__echo")
    expect(offered(1)).toContain("mcp__demo__echo")
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

    script([fauxAssistantMessage("no tools for me")])
    await turn(stub, "row-turn-2", "what can you do now")

    expect(offered(0)).not.toContain("tool_search")
    expect(offered(0)).not.toContain("mcp__demo__echo")

    expect(await cmd(stub, "row-enable", "plugin.enable", { id: "tool-mcp", enabled: true })).toMatchObject({
      ok: true,
      result: { application: "applied", row: { state: { kind: "active" } } },
    })

    script([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("mcp__demo__echo", { text: "again" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "row-turn-3", "say hi again")

    expect(offered(0)).toContain("tool_search")
    expect(offered(1)).toContain("mcp__demo__echo")
    expect(await lastToolResult(stub)).toEqual({ isError: false, text: "echo:again" })
  }, 30_000)
})
