import { afterEach, expect, test } from "bun:test"
import { cachedContext, ensureContext, refreshContext } from "./context.ts"

const sent: number[] = []
const realFetch = globalThis.fetch

function serve(): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: string; op: string; args: { conv: number } }
    sent.push(body.args.conv)
    const result = { conversation: body.args.conv, contextWindow: 200_000, used: 1_000, compactAt: 180_000, categories: [] }
    return new Response(JSON.stringify({ t: "ack", id: body.id, ok: true, result }))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  sent.length = 0
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
