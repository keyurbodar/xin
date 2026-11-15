import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { cached, cmd, invalidateReads, live, MAX_BATCH, noteHomeRev, READ_TTL_MS, Streams } from "./api.ts"

type Frame = { readonly id: string; readonly op: string; readonly args: unknown; readonly read?: boolean }

/** Each `POST /v1/cmd` the tab sends, with the frames it carried. */
let posts: Frame[][] = []
/** What the next POST answers: the acks, a whole-request failure, or acks with a home revision header. */
let reply: { status?: number; rev?: string } = {}

const ack = (frame: Frame) =>
  frame.op === "broken"
    ? { t: "ack", id: frame.id, ok: false, error: { code: "failed", message: "broken" } }
    : { t: "ack", id: frame.id, ok: true, result: { op: frame.op, args: frame.args } }

const saved = Object.fromEntries(
  ["fetch", "WebSocket", "location", "localStorage"].map((name) => [name, Reflect.get(globalThis, name)]),
)

function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

beforeEach(() => {
  posts = []
  reply = {}
  invalidateReads()
  install("localStorage", { getItem: () => "own_token", setItem: () => undefined, removeItem: () => undefined })
  install("fetch", async (_input: string, init: { body: string }) => {
    const body: unknown = JSON.parse(init.body)
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    posts.push(frames)
    const { status, rev } = reply
    reply = {}
    if (status !== undefined) return new Response("boom", { status })
    const headers = rev === undefined ? undefined : { "x-ingle-rev": rev }
    return Response.json(Array.isArray(body) ? frames.map(ack) : ack(frames[0] as Frame), headers === undefined ? {} : { headers })
  })
})

afterEach(() => {
  setSystemTime()
  for (const [name, value] of Object.entries(saved)) install(name, value)
})

/** What Extensions → Customize opens with. */
const CUSTOMIZE = ["plugin.list", "plugin.catalog", "plugin.packages", "preset.list", "mcp.list"]

describe("cmd batching and the read cache", () => {
  it("sends the reads a screen opens with as one request, and reopening it costs none", async () => {
    const results = await Promise.all(CUSTOMIZE.map((op) => cached(op)))
    expect(results.map((result) => (result as { op: string }).op)).toEqual(CUSTOMIZE)
    expect(posts.map((frames) => frames.length)).toEqual([CUSTOMIZE.length])

    await Promise.all(CUSTOMIZE.map((op) => cached(op)))
    expect(posts).toHaveLength(1)
  })

  it("shares one request between callers of the same read", async () => {
    await Promise.all([cached("skill.list"), cached("skill.list"), cached("market.entry", { name: "a" })])
    expect(posts.map((frames) => frames.map((frame) => frame.op))).toEqual([["skill.list", "market.entry"]])
  })

  it("drops cached reads once a command succeeds, so the next read goes to the home", async () => {
    await cached("memory.list")
    await cmd("memory.add", { text: "x" })
    await cached("memory.list")
    expect(posts.map((frames) => frames.map((frame) => frame.op))).toEqual([
      ["memory.list"],
      ["memory.add"],
      ["memory.list"],
    ])
  })

  it("keeps a failed command to its own caller and does not cache a failed read", async () => {
    const [ok, failed] = await Promise.allSettled([cached("plugin.list"), cached("broken")])
    expect(ok.status).toBe("fulfilled")
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "failed" } })
    await cached("broken").catch(() => undefined)
    expect(posts).toHaveLength(2)
  })

  it("splits more commands than a batch holds across requests", async () => {
    await Promise.all(Array.from({ length: MAX_BATCH + 3 }, (_, index) => cached(`read.${index}`)))
    expect(posts.map((frames) => frames.length)).toEqual([MAX_BATCH, 3])
  })

  it("sends a lone command as a single frame", async () => {
    await cmd("owner.write", { name: "k" })
    expect(posts).toHaveLength(1)
    const [frames] = posts
    expect(frames).toHaveLength(1)
  })
})

describe("the home stream and the read cache", () => {
  it("drops cached reads when a home snapshot arrives", async () => {
    let socket: { emit(type: string, data?: string): void } | undefined
    install("location", { href: "https://ingle.test/" })
    install(
      "WebSocket",
      class {
        static readonly OPEN = 1
        readyState = 1
        readonly #listeners = new Map<string, ((event: { data?: string | undefined }) => void)[]>()
        constructor() {
          socket = this
        }
        addEventListener(type: string, listener: (event: { data?: string | undefined }) => void): void {
          this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
        }
        send(): void {}
        close(): void {}
        emit(type: string, data?: string): void {
          for (const listener of this.#listeners.get(type) ?? []) listener({ data })
        }
      },
    )
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    )
    streams.subscribe("home", { value: () => undefined, delta: () => undefined })
    streams.open()
    await cached("plugin.list")
    await cached("plugin.list")
    socket?.emit("message", JSON.stringify({ t: "snap", stream: "conv:1", value: {} }))
    await cached("plugin.list")
    expect(posts).toHaveLength(1)
    socket?.emit("message", JSON.stringify({ t: "snap", stream: "home", value: {}, rev: "r2" }))
    await cached("plugin.list")
    expect(posts).toHaveLength(2)
    socket?.emit("message", JSON.stringify({ t: "changed", stream: "home", rev: "other-tab.3" }))
    await cached("plugin.list")
    expect(posts).toHaveLength(3)
  })
})

const ops = () => posts.map((frames) => frames.map((frame) => frame.op))

describe("what keeps the read cache honest", () => {
  it("lets a Settings screen reopen from the cache while its live reads still go out", async () => {
    const open = () => Promise.all([cached("owner.read"), cached("notify.prefs"), live("session.list"), live("usage.summary")])
    await open()
    await open()
    expect(ops()).toEqual([["owner.read", "notify.prefs", "session.list", "usage.summary"], ["session.list", "usage.summary"]])
    expect(posts[0]?.map((frame) => frame.read)).toEqual([true, true, true, true])
  })

  it("drops the cache when a batch holding a mutation fails as a whole", async () => {
    await cached("owner.read")
    reply = { status: 500 }
    await Promise.allSettled([cmd("owner.set", { name: "b" }), cached("plugin.list")])
    await cached("owner.read")
    expect(ops()).toEqual([["owner.read"], ["owner.set", "plugin.list"], ["owner.read"]])
    expect(posts[1]?.[0]?.read).toBeUndefined()
  })

  it("drops the cache when the home announces a revision this tab has not seen", async () => {
    await cached("owner.read")
    noteHomeRev("other-tab.1")
    await cached("owner.read")
    noteHomeRev("other-tab.1")
    await cached("owner.read")
    expect(ops()).toEqual([["owner.read"], ["owner.read"]])
  })

  it("does not refetch twice when its own command's revision comes back on the socket", async () => {
    reply = { rev: "own.7" }
    await cmd("owner.set", { name: "c" })
    await cached("owner.read")
    noteHomeRev("own.7")
    await cached("owner.read")
    expect(ops()).toEqual([["owner.set"], ["owner.read"]])
  })

  it("ages a cached read out after the TTL", async () => {
    const start = Date.now()
    setSystemTime(new Date(start))
    await cached("skill.list")
    setSystemTime(new Date(start + READ_TTL_MS - 1))
    await cached("skill.list")
    setSystemTime(new Date(start + READ_TTL_MS + 1))
    await cached("skill.list")
    expect(ops()).toEqual([["skill.list"], ["skill.list"]])
  })
})
