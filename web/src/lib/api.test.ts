import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { REFUSED_HANDSHAKES, Streams } from "./api.ts"

type Listener = (event: { data?: unknown }) => void

/** Every request the tab makes, as the Worker would count them. */
let requests: string[] = []
let dialled: string[] = []
let statusReply = 401
let accept = false
let sent: unknown[] = []
let sockets: FakeSocket[] = []
let stored = "own_revoked"
/** A status reply the test resolves by hand, so a token can change while the check is in flight. */
let pending: ((status: number) => void) | undefined
let hold = false

class FakeSocket {
  static readonly OPEN = 1
  readyState = 0
  readonly #listeners = new Map<string, Listener[]>()

  constructor(url: URL, protocols: readonly string[]) {
    requests.push(`socket ${url.pathname}`)
    sockets.push(this)
    dialled.push(protocols.find((protocol) => protocol.startsWith("bearer.")) ?? "")
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
  dialled = []
  statusReply = 401
  accept = false
  sent = []
  sockets = []
  stored = "own_revoked"
  pending = undefined
  hold = false
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", FakeSocket)
  vi.stubGlobal("location", { href: "https://ingle.test/" })
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined })
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value
    },
    removeItem: () => {
      stored = ""
    },
  })
  vi.stubGlobal("fetch", async (input: string, init?: { headers?: Record<string, string> }) => {
    requests.push(`fetch ${input} ${init?.headers?.["authorization"] ?? ""}`.trim())
    const status = hold ? await new Promise<number>((resolve) => (pending = resolve)) : statusReply
    return new Response(null, { status })
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
      "fetch /v1/status Bearer own_revoked",
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
    const checks = requests.filter((request) => request.startsWith("fetch /v1/status")).length
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

describe("Streams when the token changes under a check", () => {
  it("ignores a 401 for a token that was replaced while the check was in flight", async () => {
    hold = true
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    streams.open()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pending).toBeDefined()
    stored = "own_replacement"
    accept = true
    streams.reconnectNow()
    pending?.(401)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(signedOut).toBe(0)
    expect(dialled.at(-1)).toBe("bearer.own_replacement")
    expect(dialled.filter((bearer) => bearer === "bearer.own_replacement")).toHaveLength(1)
  })

  it("dials nothing while paused for a released token, and resumes on the next token", async () => {
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    accept = true
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    streams.pause()
    accept = false
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(signedOut).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
    stored = "own_replacement"
    accept = true
    streams.reconnectNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(dialled).toEqual(["bearer.own_revoked", "bearer.own_replacement"])
  })

  it("ignores a 401 for a token another tab replaced, with no reconnect asked for", async () => {
    hold = true
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    streams.open()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pending).toBeDefined()
    stored = "own_replacement"
    accept = true
    pending?.(401)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(signedOut).toBe(0)
    expect(dialled.at(-1)).toBe("bearer.own_replacement")
  })

  it("keeps the hold through a push-driven reconnect while the retired token is still stored", async () => {
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    accept = true
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    streams.pause()
    accept = false
    for (let push = 0; push < 5; push += 1) {
      streams.reconnectNow()
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(signedOut).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
  })

  it("resumes on the same token when the rotation that held it failed", async () => {
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => undefined,
    )
    accept = true
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    streams.pause()
    streams.resume()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(dialled).toEqual(["bearer.own_revoked", "bearer.own_revoked"])
  })

  it("keeps the hold when another tab signs out and empties the shared token", async () => {
    let signedOut = 0
    const streams = new Streams(
      () => undefined,
      () => undefined,
      () => {
        signedOut += 1
      },
    )
    accept = true
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    streams.pause()
    accept = false
    stored = ""
    for (let push = 0; push < 5; push += 1) {
      streams.reconnectNow()
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(signedOut).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
    stored = "own_replacement"
    accept = true
    streams.reconnectNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(dialled).toEqual(["bearer.own_revoked", "bearer.own_replacement"])
  })
})

describe("Streams on a reconnect", () => {
  const quiet = () =>
    new Streams(
      () => undefined,
      () => undefined,
      () => undefined,
    )

  it("resubscribes with what each stream holds and hands the server's answer to it", async () => {
    accept = true
    const applied: unknown[] = []
    const streams = quiet()
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

  it("gives a subscriber that joins during the resume a snapshot, never the delta", async () => {
    accept = true
    const early: unknown[] = []
    const late: string[] = []
    const streams = quiet()
    streams.subscribe("conv:7", {
      value: () => early.push("snap"),
      delta: () => undefined,
      resume: { cursor: () => ({ start: 1, from: 4 }), apply: () => early.push("resume") },
    })
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    streams.reconnectNow()
    await vi.advanceTimersByTimeAsync(1_000)
    sent = []
    streams.subscribe("conv:7", {
      value: () => late.push("snap"),
      delta: () => undefined,
      resume: { cursor: () => ({ start: 0, from: 0 }), apply: () => late.push("resume") },
    })
    expect(sent).toEqual([{ t: "sub", stream: "conv:7" }])
    const socket = sockets.at(-1)
    socket?.deliver({ t: "resume", stream: "conv:7", value: { entries: [{ id: 4 }] }, start: 1 })
    socket?.deliver({ t: "snap", stream: "conv:7", value: { entries: [{ id: 1 }, { id: 4 }] } })
    expect(late).toEqual(["snap"])
    expect(early).toEqual(["resume", "snap"])
  })

  it("asks a second subscriber of a live stream for a snapshot", async () => {
    accept = true
    const streams = quiet()
    streams.subscribe("conv:7", { value: () => undefined, delta: () => undefined })
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    sent = []
    streams.subscribe("conv:7", { value: () => undefined, delta: () => undefined })
    expect(sent).toEqual([{ t: "sub", stream: "conv:7" }])
  })

  it("falls back to a plain sub when a server without resume refuses the frame", async () => {
    accept = true
    const streams = quiet()
    streams.subscribe("conv:7", {
      value: () => undefined,
      delta: () => undefined,
      resume: { cursor: () => ({ start: 3, from: 9 }), apply: () => undefined },
    })
    streams.open()
    await vi.advanceTimersByTimeAsync(0)
    streams.reconnectNow()
    await vi.advanceTimersByTimeAsync(1_000)
    sent = []
    sockets.at(-1)?.deliver({ t: "error", message: "unknown frame" })
    expect(sent).toEqual([{ t: "sub", stream: "conv:7" }])
    sockets.at(-1)?.deliver({ t: "error", message: "unknown frame" })
    expect(sent).toHaveLength(1)
  })
})
