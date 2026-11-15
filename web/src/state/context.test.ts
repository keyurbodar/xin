import { afterEach, expect, test } from "bun:test"
import { cachedContext, configureConversation, ensureContext, refreshContext, selectPreset } from "./context.ts"

const sent: number[] = []
const ops: string[] = []
const realFetch = globalThis.fetch

function serve(): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: string; op: string; args: { conv: number } }
    ops.push(body.op)
    if (body.op === "conv.context") sent.push(body.args.conv)
    const result = { conversation: body.args.conv, contextWindow: 200_000, used: 1_000, compactAt: 180_000, categories: [] }
    return new Response(JSON.stringify({ t: "ack", id: body.id, ok: true, result }))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  sent.length = 0
  ops.length = 0
})

test("switching coordinator, thread, coordinator sends conv.context once per conversation", async () => {
  serve()
  await ensureContext(3)
  await ensureContext(9)
  await ensureContext(3)
  await ensureContext(9)
  expect(sent).toEqual([3, 9])
  expect(cachedContext(3)?.used).toBe(1_000)
})

test("a finished turn or an opened popover reads again, and overlapping reads share one request", async () => {
  serve()
  await Promise.all([refreshContext(3), refreshContext(3), ensureContext(3)])
  expect(sent).toEqual([3])
})

test("a model or preset change reads the context again; a thinking change does not", async () => {
  serve()
  await ensureContext(5)
  await configureConversation(5, { thinking: "high" })
  await configureConversation(5, { model: { provider: "p", modelId: "m" } })
  await selectPreset(5, "lean")
  expect(ops).toEqual(["conv.context", "conv.configure", "conv.configure", "conv.context", "preset.select", "conv.context"])
})
