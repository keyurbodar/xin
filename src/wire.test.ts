import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { describe, expect, it } from "vitest"
import { connect, owner } from "../test/support.ts"
import { FAUX_MODEL, type Home } from "../test/worker.ts"
import { SNAPSHOT_ENTRIES } from "./wire.ts"

type View = { entries: { id: number; kind: string }[] }
const isView = (value: unknown): value is View =>
  typeof value === "object" && value !== null && "entries" in value && Array.isArray(value.entries)

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
})
