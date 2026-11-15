import { describe, expect, it } from "vitest"
import { api, owner } from "../test/support.ts"
import { MAX_BATCH } from "./kernel/wire.ts"

type Ack = { readonly t: "ack"; readonly id: string; readonly ok: boolean; readonly result?: unknown }

const listFrame = (index: number) => ({ id: `over-${crypto.randomUUID()}-${index}`, op: "plugin.list", args: {} })

const post = (body: unknown) => api("/v1/cmd", { method: "POST", body: JSON.stringify(body) })

/** Home requests one call costs, counted around it. */
async function homeRequests(send: () => Promise<Response>): Promise<{ reply: unknown; requests: number }> {
  const before = await owner().requests()
  const reply: unknown = await (await send()).json()
  return { reply, requests: (await owner().requests()) - before }
}

describe("batched /v1/cmd", () => {
  it("runs an array of commands in order in one home request and answers an array of acks", async () => {
    const reads = ["plugin.list", "session.list", "system.version", "owner.read", "preset.list"]
    const frames = reads.map((op, index) => ({ id: `batch-${crypto.randomUUID()}-${index}`, op, args: {} }))

    const one = await homeRequests(() => post(frames))
    expect(one.requests).toBe(1)
    if (!Array.isArray(one.reply)) throw new Error(`not an array: ${JSON.stringify(one.reply)}`)
    const acks: Ack[] = one.reply
    expect(acks.map((ack) => ack.id)).toEqual(frames.map((frame) => frame.id))
    expect(acks.every((ack) => ack.ok)).toBe(true)

    let separate = 0
    for (const frame of frames)
      separate += (await homeRequests(() => post({ ...frame, id: `${frame.id}-alone` }))).requests
    expect(separate).toBe(reads.length)
  })

  it("keeps a failed command to its own ack and runs the rest", async () => {
    const reply = await (
      await post([
        { id: `ok-${crypto.randomUUID()}`, op: "plugin.list", args: {} },
        { id: `bad-${crypto.randomUUID()}`, op: "no.such.op", args: {} },
        { id: `ok-${crypto.randomUUID()}`, op: "session.list", args: {} },
      ])
    ).json<Ack[]>()
    expect(reply.map((ack) => ack.ok)).toEqual([true, false, true])
  })

  it("dedupes a replayed batch on its command ids", async () => {
    const id = `rotate-${crypto.randomUUID()}`
    const frames = [{ id, op: "session.rotate", args: {} }]
    const first = await (await post(frames)).json<Ack[]>()
    const second = await (await post(frames)).json<Ack[]>()
    expect(second).toEqual(first)
  })

  it("still answers a single frame with a single ack", async () => {
    const reply = await (await post({ id: `one-${crypto.randomUUID()}`, op: "plugin.list", args: {} })).json<Ack>()
    expect(reply).toMatchObject({ t: "ack", ok: true })
  })

  it("refuses an empty, oversized or malformed batch", async () => {
    expect((await post([])).status).toBe(400)
    expect((await post(Array.from({ length: MAX_BATCH + 1 }, (_, index) => listFrame(index)))).status).toBe(400)
    expect((await post([listFrame(0), { op: "plugin.list" }])).status).toBe(400)
  })
})
