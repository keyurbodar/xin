import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { api, connect, fresh, owner, OWNER_HEADERS } from "../test/support.ts"
import type { Home } from "../test/worker.ts"
import { MAX_BATCH } from "./kernel/wire.ts"

type Ack = { readonly t: "ack"; readonly id: string; readonly ok: boolean; readonly result?: unknown }

const listFrame = (index: number) => ({ id: `over-${crypto.randomUUID()}-${index}`, op: "plugin.list", args: {} })

const bump = (id: string, by: number) => ({ id: `${id}-${crypto.randomUUID()}`, op: "test.bump", args: { by } })

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

describe("a batch that throws, and the home revision", () => {
  it("answers frames before a throw, fails the one that threw, and runs none after it", async () => {
    const stub = fresh()
    const reply = await stub.fetch("https://ingle.internal/v1/cmd", {
      method: "POST",
      headers: OWNER_HEADERS,
      body: JSON.stringify([bump("a", 1), bump("b", 666), bump("c", 2)]),
    })
    expect(reply.status).toBe(200)
    const acks = await reply.json<{ ok: boolean; result?: unknown; error?: { code: string } }[]>()
    expect(acks.map((ack) => (ack.ok ? "ok" : ack.error?.code))).toEqual(["ok", "failed", "not_run"])
    const after = await stub.fetch("https://ingle.internal/v1/cmd", {
      method: "POST",
      headers: OWNER_HEADERS,
      body: JSON.stringify(bump("d", 10)),
    })
    expect((await after.json<{ result: unknown }>()).result).toBe(11)
  })

  it("lets the home, not the client, decide what is a read", async () => {
    const claimed = await post({ id: `w-${crypto.randomUUID()}`, op: "test.bump", args: { by: 1 }, read: true })
    expect(claimed.headers.get("x-ingle-rev")).toEqual(expect.any(String))
  })

  it("announces a mutating batch to home subscribers in a frame, and a read-only batch not at all", async () => {
    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    await socket.next((frame) => frame.t === "snap" && frame.stream === "home")

    const write = await post({ id: `w-${crypto.randomUUID()}`, op: "test.bump", args: { by: 1 } })
    const rev = write.headers.get("x-ingle-rev")
    expect(rev).toEqual(expect.any(String))
    const changed = await socket.next((frame) => frame.t === "changed")
    expect(changed).toEqual({ t: "changed", stream: "home", rev })
    expect(new TextEncoder().encode(JSON.stringify(changed)).byteLength).toBeLessThan(80)

    const read = await post([{ id: `r-${crypto.randomUUID()}`, op: "plugin.list", args: {} }])
    expect(read.headers.get("x-ingle-rev")).toBeNull()

    await post({ id: `w-${crypto.randomUUID()}`, op: "test.bump", args: { by: 1 } })
    const next = await socket.next((frame) => frame.t === "changed")
    const [epoch, count] = String(rev).split(".")
    expect(next.rev).toBe(`${epoch}.${Number(count) + 1}`)
    socket.close()
  })

  it("tells home subscribers once for agent writes that land in the same tick", async () => {
    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    await socket.next((frame) => frame.t === "snap" && frame.stream === "home")
    await runInDurableObject(owner(), async (home: Home) => {
      const at = Date.now()
      await Promise.all(
        ["one", "two", "three"].map((text) =>
          home.services.memory.remember({ text, scope: "me", at, source: "agent", originTask: "probe" }),
        ),
      )
    })
    const told = await socket.next((frame) => frame.t === "changed")
    const write = await post({ id: `w-${crypto.randomUUID()}`, op: "test.bump", args: { by: 1 } })
    expect(await socket.next((frame) => frame.t === "changed")).toEqual({
      t: "changed",
      stream: "home",
      rev: write.headers.get("x-ingle-rev"),
    })
    const [epoch, count] = String(told.rev).split(".")
    expect(write.headers.get("x-ingle-rev")).toBe(`${epoch}.${Number(count) + 1}`)
    socket.close()
  })
})
