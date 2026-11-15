import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cached, cmd, invalidateReads, MAX_BATCH, Streams } from "./api.ts"

type Frame = { readonly id: string; readonly op: string; readonly args: unknown }

/** Each `POST /v1/cmd` the tab sends, with the frames it carried. */
let posts: Frame[][] = []

const ack = (frame: Frame) =>
  frame.op === "broken"
    ? { t: "ack", id: frame.id, ok: false, error: { code: "failed", message: "broken" } }
    : { t: "ack", id: frame.id, ok: true, result: { op: frame.op, args: frame.args } }

beforeEach(() => {
  posts = []
  invalidateReads()
  vi.stubGlobal("localStorage", { getItem: () => "own_token", setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal("fetch", async (_input: string, init: { body: string }) => {
    const body: unknown = JSON.parse(init.body)
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    posts.push(frames)
    return Response.json(Array.isArray(body) ? frames.map(ack) : ack(frames[0] as Frame))
  })
})

afterEach(() => vi.unstubAllGlobals())

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
    vi.stubGlobal("location", { href: "https://ingle.test/" })
    vi.stubGlobal(
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
  })
})
