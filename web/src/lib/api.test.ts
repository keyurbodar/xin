import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { REFUSED_HANDSHAKES, Streams } from "./api.ts"

type Listener = (event: { data?: unknown }) => void

/** Every request the tab makes, as the Worker would count them. */
let requests: string[] = []
let statusReply = 401
let accept = false
let sent: unknown[] = []
let sockets: FakeSocket[] = []

class FakeSocket {
  static readonly OPEN = 1
  readyState = 0
  readonly #listeners = new Map<string, Listener[]>()

  constructor(url: URL) {
    requests.push(`socket ${url.pathname}`)
    sockets.push(this)
    queueMicrotask(() => {
      if (accept) {
        this.readyState = FakeSocket.OPEN
        this.#emit("open", {})
      } else this.close()
    })
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  send(frame: string): void {
    sent.push(JSON.parse(frame))
  }

  deliver(frame: unknown): void {
    this.#emit("message", { data: JSON.stringify(frame) })
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.#emit("close", {})
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

beforeEach(() => {
  requests = []
  statusReply = 401
  accept = false
  sent = []
  sockets = []
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", FakeSocket)
  vi.stubGlobal("location", { href: "https://ingle.test/" })
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined })
  vi.stubGlobal("localStorage", { getItem: () => "own_revoked", setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal("fetch", async (input: string) => {
    requests.push(`fetch ${input}`)
    return new Response(null, { status: statusReply })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const HOUR = 60 * 60_000

describe("Streams on a refused token", () => {
  it("checks /v1/status once after a run of refused handshakes and stops dialling on a 401", async () => {
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    streams.open()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(signedOut).toBe(1)
    expect(requests).toEqual([
      ...Array.from({ length: REFUSED_HANDSHAKES }, () => "socket /v1/socket"),
      "fetch /v1/status",
    ])
  })

  it("keeps the backoff when the token still works, asking again only after another run", async () => {
    statusReply = 503
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    streams.open()
    await vi.advanceTimersByTimeAsync(HOUR)
    const dials = requests.filter((request) => request.startsWith("socket")).length
    const checks = requests.filter((request) => request === "fetch /v1/status").length
    expect(signedOut).toBe(0)
    expect(dials).toBeLessThanOrEqual(HOUR / 15_000 + 10)
    expect(checks).toBe(Math.floor(dials / REFUSED_HANDSHAKES))
  })

  it("never asks /v1/status while handshakes succeed", async () => {
    accept = true
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => undefined,
    )
    streams.open()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(requests).toEqual(["socket /v1/socket"])
  })
})

describe("Streams on a reconnect", () => {
  it("resubscribes with what each stream holds and hands the server's answer to it", async () => {
    accept = true
    const applied: unknown[] = []
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => undefined,
    )
    streams.subscribe("conv:7", {
      value: () => undefined,
      delta: () => undefined,
      resume: { cursor: () => ({ start: 3, from: 9 }), apply: (value, start) => applied.push({ value, start }) },
    })
    streams.subscribe("home", { value: () => undefined, delta: () => undefined })
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    sent = []
    streams.reconnectNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toEqual([
      { t: "sub", stream: "conv:7", resume: { start: 3, from: 9 } },
      { t: "sub", stream: "home" },
    ])
    sockets.at(-1)?.deliver({ t: "resume", stream: "conv:7", value: { entries: [] }, start: 5 })
    expect(applied).toEqual([{ value: { entries: [] }, start: 5 }])
  })
})
