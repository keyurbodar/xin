import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { describe, expect, it } from "vitest"
import { api, connect, cmd, field, owner } from "../test/support.ts"
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

  it("republishes the home projection when a plugin row is enabled or disabled", async () => {
    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    await socket.next((f) => f.t === "snap")
    await cmd(owner(), `off-${crypto.randomUUID()}`, "plugin.enable", { id: "test", enabled: false })
    expect(await socket.next((f) => f.t === "snap")).toMatchObject({ value: { plugins: { test: "disabled" } } })
    await cmd(owner(), `on-${crypto.randomUUID()}`, "plugin.enable", { id: "test", enabled: true })
    expect(await socket.next((f) => f.t === "snap")).toMatchObject({ value: { plugins: { test: "active" } } })
    const bump = await api("/v1/cmd", {
      method: "POST",
      body: JSON.stringify({ id: `b-${crypto.randomUUID()}`, op: "test.bump", args: { by: 1 } }),
    })
    expect(await socket.next((f) => f.t === "changed")).toMatchObject({ rev: bump.headers.get("x-ingle-rev") })
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
    expect(await socket.next((f) => f.t === "hello")).toMatchObject({ socket: live.id })

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

const bytes = (frame: unknown): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength

describe("stream resume", () => {
  it("answers a conversation resubscribe with only the entries after its cursor, rebuilding the shared window", async () => {
    const rootId = await runInDurableObject(owner(), async (home: Home) => {
      home.script(["one", "two", "three"])
      await home.chooseModel(FAUX_MODEL)
      const root = await home.root()
      await home.submit("first", "resume-1")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      return root.id
    })
    const stream = `conv:${rootId}`
    const watcher = await connect()
    watcher.send({ t: "sub", stream })
    await watcher.next((f) => f.t === "snap" && f.stream === stream)

    const first = await connect()
    first.send({ t: "sub", stream })
    const held = await first.next((f) => f.t === "snap" && f.stream === stream)
    first.close()
    if (!isView(held.value)) throw new Error("snapshot is not a conversation view")
    const ids = held.value.entries.map((entry) => entry.id)
    const cursor = { start: ids[0] ?? 0, from: (ids.at(-1) ?? 0) + 1 }

    await runInDurableObject(owner(), async (home: Home) => {
      await home.submit("second", "resume-2")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    })

    const again = await connect()
    again.send({ t: "sub", stream, resume: cursor })
    const resumed = await again.next((f) => (f.t === "resume" || f.t === "snap") && f.stream === stream)
    const fresh = await connect()
    fresh.send({ t: "sub", stream })
    const snap = await fresh.next((f) => f.t === "snap" && f.stream === stream)
    if (!isView(resumed.value) || !isView(snap.value)) throw new Error("not a conversation view")

    expect(resumed.t).toBe("resume")
    expect(resumed.value.entries.length).toBeGreaterThan(0)
    expect(resumed.value.entries.every((entry) => entry.id >= cursor.from)).toBe(true)
    const start = field(resumed, "start")
    if (typeof start !== "number") throw new Error("resume carries no window start")
    const rebuilt = [...held.value.entries.filter((entry) => entry.id >= start), ...resumed.value.entries]
    expect(rebuilt).toEqual(snap.value.entries)
    expect(bytes(resumed)).toBeLessThan(bytes(snap) / 2)
    for (const socket of [watcher, again, fresh]) socket.close()
  })

  it("sends nothing new to a resubscribe that already holds the newest entry", async () => {
    const rootId = await runInDurableObject(owner(), async (home: Home) => {
      home.script(["only"])
      await home.chooseModel(FAUX_MODEL)
      const root = await home.root()
      await home.submit("hi", "resume-idle-1")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      return root.id
    })
    const stream = `conv:${rootId}`
    const socket = await connect()
    socket.send({ t: "sub", stream })
    const snap = await socket.next((f) => f.t === "snap" && f.stream === stream)
    socket.close()
    if (!isView(snap.value)) throw new Error("not a conversation view")
    const ids = snap.value.entries.map((entry) => entry.id)
    const again = await connect()
    again.send({ t: "sub", stream, resume: { start: ids[0] ?? 0, from: (ids.at(-1) ?? 0) + 1 } })
    const resumed = await again.next((f) => f.t === "resume" && f.stream === stream)
    again.close()
    if (!isView(resumed.value)) throw new Error("not a conversation view")
    expect(resumed.value.entries).toEqual([])
    expect(bytes(resumed)).toBeLessThan(bytes(snap))
  })

  it("falls back to a snapshot when the cursor does not reach back to the shared window", async () => {
    const rootId = await runInDurableObject(owner(), async (home: Home) => {
      home.script(["a"])
      await home.chooseModel(FAUX_MODEL)
      const root = await home.root()
      await home.submit("hi", "resume-gap-1")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      return root.id
    })
    const stream = `conv:${rootId}`
    const socket = await connect()
    socket.send({ t: "sub", stream, resume: { start: Number.MAX_SAFE_INTEGER, from: Number.MAX_SAFE_INTEGER } })
    expect(await socket.next((f) => (f.t === "snap" || f.t === "resume") && f.stream === stream)).toMatchObject({
      t: "snap",
    })
    socket.close()
  })

  it("tells a home resubscribe with the current revision that nothing changed", async () => {
    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    const snap = await socket.next((f) => f.t === "snap" && f.stream === "home")
    socket.close()
    const rev = field(snap, "rev")
    if (typeof rev !== "string") throw new Error("home snapshot carries no revision")

    const again = await connect()
    again.send({ t: "sub", stream: "home", resume: { rev } })
    const resumed = await again.next((f) => (f.t === "resume" || f.t === "snap") && f.stream === "home")
    expect(resumed).toEqual({ t: "resume", stream: "home" })
    expect(bytes(resumed)).toBeLessThan(64)
    again.send({ t: "unsub", stream: "home" })
    again.send({ t: "sub", stream: "home", resume: { rev: "stale" } })
    expect(await again.next((f) => (f.t === "resume" || f.t === "snap") && f.stream === "home")).toMatchObject({
      t: "snap",
      rev,
    })
    again.close()
  })
})
