import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { describe, expect, it } from "vitest"
import { connect, cmd, field, owner } from "../test/support.ts"
import { FAUX_MODEL, type Home } from "../test/worker.ts"
import { SNAPSHOT_ENTRIES } from "./wire.ts"

type View = { entries: { id: number; kind: string }[] }
const isView = (value: unknown): value is View =>
  typeof value === "object" && value !== null && "entries" in value && Array.isArray(value.entries)

type Session = { id: string; since: number; origin: string }

const sessions = async (): Promise<Session[]> => {
  const reply = await cmd(owner(), `sessions-${crypto.randomUUID()}`, "session.list")
  if (!Array.isArray(reply.result)) throw new Error(`session.list: ${JSON.stringify(reply)}`)
  return reply.result.map((row) => {
    const id = field(row, "id")
    const since = field(row, "since")
    const origin = field(row, "origin")
    if (typeof id !== "string" || typeof since !== "number" || typeof origin !== "string")
      throw new Error(`session row is malformed: ${JSON.stringify(row)}`)
    return { id, since, origin }
  })
}

const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not reached")
}

const closeAll = async (): Promise<number> => {
  const reply = await cmd(owner(), `sessions-${crypto.randomUUID()}`, "session.close", {})
  const closed = field(reply.result, "closed")
  if (typeof closed !== "number") throw new Error(`session.close: ${JSON.stringify(reply)}`)
  return closed
}

describe("wire protocol", () => {
  it("acks commands over the socket and answers pings without the object", async () => {
    const socket = await connect()
    socket.send({ t: "cmd", id: "ws-1", op: "test.bump", args: { by: 2 } })
    expect(await socket.next((f) => f.t === "ack")).toMatchObject({ id: "ws-1", ok: true })
    socket.send({ _tag: "Ping" })
    expect(await socket.next((f) => f._tag === "Pong")).toEqual({ _tag: "Pong" })
    socket.send({ t: "nope" })
    expect(await socket.next((f) => f.t === "error")).toMatchObject({ message: "unknown frame" })
    socket.close()
  })

  it("streams a conversation, and after eviction a fresh snapshot equals the stored state", async () => {
    const rootId = await runInDurableObject(owner(), async (home: Home) => {
      home.script(["first reply"])
      await home.chooseModel(FAUX_MODEL)
      return (await home.root()).id
    })
    const stream = `conv:${rootId}`
    const socket = await connect()
    socket.send({ t: "sub", stream })
    const before = await socket.next((f) => f.t === "snap" && f.stream === stream)
    await runInDurableObject(owner(), async (home: Home) => {
      await home.submit("hello there", "wire-turn-1")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    })
    expect(await socket.next((f) => f.t === "ev" && f.stream === stream)).toMatchObject({ events: expect.any(Array) })
    socket.close()

    await evictDurableObject(owner())
    const again = await connect()
    again.send({ t: "sub", stream })
    const snap = await again.next((f) => f.t === "snap" && f.stream === stream)
    const stored = await runInDurableObject(owner(), async (home: Home) => {
      const page = await (
        await home.root()
      ).entries({ order: "descending" }, SNAPSHOT_ENTRIES, undefined, BACKGROUND_CONTEXT)
      return page.items.map((entry) => ({ id: entry.id, kind: entry.kind })).toReversed()
    })
    if (!isView(snap.value) || !isView(before.value)) throw new Error("snapshot is not a conversation view")
    expect(snap.value.entries.map(({ id, kind }) => ({ id, kind }))).toEqual(stored)
    expect(snap.value.entries.length).toBeGreaterThan(before.value.entries.length)
    again.close()
  })

  it("serves the home projection and refuses unknown streams", async () => {
    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    expect(await socket.next((f) => f.t === "snap")).toMatchObject({
      value: { plugins: { test: "active", broken: "failed", orphan: "pending" } },
    })
    socket.send({ t: "sub", stream: "conv:999999" })
    expect(await socket.next((f) => f.t === "error")).toMatchObject({ message: "unknown stream conv:999999" })
    socket.close()
  })

  it("lists a live socket and closes it by id", async () => {
    await closeAll()
    await until(async () => (await sessions()).length === 0)

    const socket = await connect()
    const [live] = await sessions()
    if (live === undefined) throw new Error("the socket is not listed")
    expect(live.id.length).toBeGreaterThan(0)
    expect(live.origin).toBe("")
    expect(live.since).toBeGreaterThan(0)

    const reply = await cmd(owner(), `close-${crypto.randomUUID()}`, "session.close", { id: live.id })
    expect(reply).toMatchObject({ ok: true, result: { closed: 1 } })
    await until(async () => (await sessions()).length === 0)
    socket.close()
  })

  it("rotates the owner token and drops every socket", async () => {
    await closeAll()
    await until(async () => (await sessions()).length === 0)

    const socket = await connect()
    const reply = await cmd(owner(), `rotate-${crypto.randomUUID()}`, "session.rotate")
    expect(field(reply.result, "token")).toMatch(/^own_[A-Za-z0-9_-]{43}$/u)
    await until(async () => (await sessions()).length === 0)
    socket.close()
  })

  it("closes every live socket and reports the count", async () => {
    await closeAll()
    await until(async () => (await sessions()).length === 0)

    const first = await connect()
    const second = await connect()
    expect(await sessions()).toHaveLength(2)
    expect(await closeAll()).toBe(2)
    await until(async () => (await sessions()).length === 0)
    first.close()
    second.close()
  })
})
