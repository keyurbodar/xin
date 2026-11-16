import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { stubGlobals } from "../../../test/globals.ts"
import { insert, root, textOf, type TestNode } from "../../../test/universal.ts"
import { invalidateReads } from "../../lib/api.ts"

type Frame = { readonly id: string; readonly op: string }

const realFetch = globalThis.fetch
stubGlobals({ window: { location: { hash: "" }, addEventListener: () => undefined } })
void mock.module("../extensions/glyph.tsx", () => ({ Glyph: () => undefined }))
void mock.module("../settings/fallbacks.tsx", () => ({ FallbackList: () => undefined }))
let Connectors: (typeof import("../extensions/customize-connectors.tsx"))["Connectors"]
let Models: (typeof import("../settings/models.tsx"))["Models"]
let servers: (typeof import("../../state/extensions.ts"))["servers"]
beforeAll(async () => {
  ;({ Connectors } = await import("../extensions/customize-connectors.tsx"))
  ;({ Models } = await import("../settings/models.tsx"))
  ;({ servers } = await import("../../state/extensions.ts"))
})

const REPLIES: Readonly<Record<string, unknown>> = {
  "mcp.list": [
    { name: "ats", url: "https://ats.example.com/mcp", tools: 2 },
    { name: "crm", url: "https://crm.example.com/mcp", tools: 0, error: "401 Unauthorized" },
  ],
  "models.list": {
    models: [
      { provider: "acme", modelId: "acme-1", name: "Acme 1", keyed: true },
      { provider: "zeta", modelId: "zeta-1", name: "Zeta 1", keyed: true },
    ],
  },
}

beforeEach(() => {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: REPLIES[frame.op] ?? {} }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const pills = (node: TestNode): string[] => [
  ...(typeof node.props["data-status"] === "string" ? [`${String(node.props["data-status"])}:${textOf(node)}`] : []),
  ...node.children.flatMap(pills),
]

test("each MCP server row ends in a status pill", async () => {
  void servers.reload()
  const tree = root()
  createRoot(() => insert(tree, createComponent(Connectors, {})))
  await Bun.sleep(20)
  expect(pills(tree)).toEqual(["connected:Connected", "error:Error"])
  expect(textOf(tree)).toContain("2 tools")
  expect(textOf(tree)).toContain("401 Unauthorized")
})

test("each provider row ends in a status pill", async () => {
  const tree = root()
  createRoot(() => insert(tree, createComponent(Models, {})))
  await Bun.sleep(20)
  expect(pills(tree)).toEqual(["connected:Connected", "connected:Connected"])
  expect(textOf(tree)).toContain("1 model · stored sealed")
})
