import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installGlobal, snapshotGlobals } from "../../test/globals.ts"
import { REFUSED_HANDSHAKES, Streams } from "./api.ts"
import { CUT_OFF_MS, cutOffIn } from "./cutoff.ts"

type Listener = (event: { data?: unknown }) => void

/** Every request the tab makes, as the Worker would count them. */
let requests: string[] = []
let dialled: string[] = []
let statusReply = 401
let accept = false
let stored = "own_revoked"
/** A status reply the test resolves by hand, so a token can change while the check is in flight. */
let pending: ((status: number) => void) | undefined
let hold = false
let sent: unknown[] = []
let sockets: FakeSocket[] = []

/** A clock the test drives: timers fire in order of their due time as `advance` moves it on. */
let now = 0
let timers: { id: number; at: number; run: () => void }[] = []
let nextId = 1

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

let restore = (): void => undefined

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function advance(ms: number): Promise<void> {
  const until = now + ms
  await settle()
  for (;;) {
    const due = timers.filter((timer) => timer.at <= until).toSorted((a, b) => a.at - b.at)[0]
    if (due === undefined) break
    timers = timers.filter((timer) => timer !== due)
    now = due.at
    due.run()
    await settle()
  }
  now = until
}

beforeEach(() => {
  restore = snapshotGlobals(["fetch", "setTimeout", "clearTimeout", "WebSocket", "document", "location", "localStorage"])
  requests = []
  dialled = []
  statusReply = 401
  accept = false
  stored = "own_revoked"
  pending = undefined
  hold = false
  sent = []
  sockets = []
  now = 0
  timers = []
  installGlobal("WebSocket", FakeSocket)
  installGlobal("location", { href: "https://ingle.test/" })
  installGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} })
  installGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value
    },
    removeItem: () => {
      stored = ""
    },
  })
  installGlobal("setTimeout", (run: () => void, delay = 0) => {
    const id = nextId++
    timers.push({ id, at: now + delay, run })
    return id
  })
  installGlobal("clearTimeout", (id: number | undefined) => {
    timers = timers.filter((timer) => timer.id !== id)
  })
  installGlobal("fetch", async (input: string, init?: { headers?: Record<string, string> }) => {
    requests.push(`fetch ${input} ${init?.headers?.["authorization"] ?? ""}`.trim())
    const status = hold ? await new Promise<number>((resolve) => (pending = resolve)) : statusReply
    return new Response(null, { status })
  })
})

afterEach(() => {
  restore()
})

const HOUR = 60 * 60_000

function streams(): { streams: Streams; signedOut: () => number; held: () => boolean } {
  let count = 0
  let held = false
  const made = new Streams(
    () => {},
    () => {},
    () => {},
    () => {
      count += 1
    },
    (holding) => {
      held = holding
    },
  )
  return { streams: made, signedOut: () => count, held: () => held }
}

describe("Streams on a refused token", () => {
  test("checks /v1/status once after a run of refused handshakes and stops dialling on a 401", async () => {
    const tab = streams()
    tab.streams.open()
    await advance(HOUR)
    expect(tab.signedOut()).toBe(1)
    expect(requests).toEqual([
      ...Array.from({ length: REFUSED_HANDSHAKES }, () => "socket /v1/socket"),
      "fetch /v1/status Bearer own_revoked",
    ])
  })

  test("keeps the backoff when the token still works, asking again only after another run", async () => {
    statusReply = 503
    const tab = streams()
    tab.streams.open()
    await advance(HOUR)
    const dials = requests.filter((request) => request.startsWith("socket")).length
    const checks = requests.filter((request) => request.startsWith("fetch /v1/status")).length
    expect(tab.signedOut()).toBe(0)
    expect(dials).toBeLessThanOrEqual(HOUR / 15_000 + 10)
    expect(checks).toBe(Math.floor(dials / REFUSED_HANDSHAKES))
  })

  test("never asks /v1/status while handshakes succeed", async () => {
    accept = true
    streams().streams.open()
    await advance(HOUR)
    expect(requests).toEqual(["socket /v1/socket"])
  })
})

describe("Streams when the token changes under a check", () => {
  test("ignores a 401 for a token that was replaced while the check was in flight", async () => {
    hold = true
    const tab = streams()
    tab.streams.open()
    await advance(5_000)
    expect(pending).toBeDefined()
    stored = "own_replacement"
    accept = true
    tab.streams.reconnectNow()
    pending?.(401)
    await advance(HOUR)
    expect(tab.signedOut()).toBe(0)
    expect(dialled.at(-1)).toBe("bearer.own_replacement")
    expect(dialled.filter((bearer) => bearer === "bearer.own_replacement")).toHaveLength(1)
  })

  test("ignores a 401 for a token another tab replaced, with no reconnect asked for", async () => {
    hold = true
    const tab = streams()
    tab.streams.open()
    await advance(5_000)
    expect(pending).toBeDefined()
    stored = "own_replacement"
    accept = true
    pending?.(401)
    await advance(HOUR)
    expect(tab.signedOut()).toBe(0)
    expect(dialled.at(-1)).toBe("bearer.own_replacement")
  })
})

describe("Streams held while a released token is shown", () => {
  test("dials nothing while paused, and resumes on the next token", async () => {
    const tab = streams()
    accept = true
    tab.streams.open()
    await advance(0)
    tab.streams.pause()
    accept = false
    await advance(HOUR)
    expect(tab.signedOut()).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
    stored = "own_replacement"
    accept = true
    tab.streams.reconnectNow()
    await advance(1_000)
    expect(dialled).toEqual(["bearer.own_revoked", "bearer.own_replacement"])
  })

  test("keeps the hold through push-driven reconnects while the retired token is still stored", async () => {
    const tab = streams()
    accept = true
    tab.streams.open()
    await advance(0)
    tab.streams.pause()
    accept = false
    for (let push = 0; push < 5; push += 1) {
      tab.streams.reconnectNow()
      tab.streams.dialNow()
      await advance(10_000)
    }
    await advance(HOUR)
    expect(tab.signedOut()).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
  })

  test("keeps the hold when another tab signs out and empties the shared token", async () => {
    const tab = streams()
    accept = true
    tab.streams.open()
    await advance(0)
    tab.streams.pause()
    accept = false
    stored = ""
    for (let push = 0; push < 5; push += 1) {
      tab.streams.reconnectNow()
      await advance(10_000)
    }
    await advance(HOUR)
    expect(tab.signedOut()).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
    stored = "own_replacement"
    accept = true
    tab.streams.reconnectNow()
    await advance(1_000)
    expect(dialled).toEqual(["bearer.own_revoked", "bearer.own_replacement"])
  })

  test("stays off the offline screen through a hold longer than the cut-off, so nothing probes or signs out", async () => {
    const tab = streams()
    accept = true
    tab.streams.open()
    await advance(0)
    const since = now
    tab.streams.pause()
    accept = false
    await advance(CUT_OFF_MS + 5_000)
    expect(tab.held()).toBe(true)
    expect(cutOffIn({ online: true, held: tab.held(), since }, now)).toBeUndefined()
    expect(cutOffIn({ online: true, held: false, since }, now)).toBe(0)
    expect(requests).toEqual(["socket /v1/socket"])
    expect(tab.signedOut()).toBe(0)
    stored = "own_replacement"
    accept = true
    tab.streams.reconnectNow()
    await advance(1_000)
    expect(tab.held()).toBe(false)
  })

  test("resumes on the same token when the rotation that held it failed", async () => {
    const tab = streams()
    accept = true
    tab.streams.open()
    await advance(0)
    tab.streams.pause()
    tab.streams.resume()
    await advance(1_000)
    expect(dialled).toEqual(["bearer.own_revoked", "bearer.own_revoked"])
  })
})

describe("Streams on a reconnect", () => {
  async function reconnected(tab: Streams): Promise<void> {
    accept = true
    tab.open()
    await advance(0)
    tab.reconnectNow()
    await advance(1_000)
  }

  test("resubscribes with what each stream holds and hands the server's answer to it", async () => {
    const applied: unknown[] = []
    const { streams: tab } = streams()
    tab.subscribe("conv:7", {
      value: () => {},
      delta: () => {},
      resume: { cursor: () => ({ start: 3, from: 9 }), apply: (value, start) => applied.push({ value, start }) },
    })
    tab.subscribe("home", { value: () => {}, delta: () => {} })
    accept = true
    tab.open()
    await advance(0)
    sent = []
    tab.reconnectNow()
    await advance(1_000)
    expect(sent).toEqual([
      { t: "sub", stream: "conv:7", resume: { start: 3, from: 9 } },
      { t: "sub", stream: "home" },
    ])
    sockets.at(-1)?.deliver({ t: "resume", stream: "conv:7", value: { entries: [] }, start: 5 })
    expect(applied).toEqual([{ value: { entries: [] }, start: 5 }])
  })

  test("gives a subscriber that joins during the resume a snapshot, never the delta", async () => {
    const early: string[] = []
    const late: string[] = []
    const { streams: tab } = streams()
    tab.subscribe("conv:7", {
      value: () => early.push("snap"),
      delta: () => {},
      resume: { cursor: () => ({ start: 1, from: 4 }), apply: () => early.push("resume") },
    })
    await reconnected(tab)
    sent = []
    tab.subscribe("conv:7", {
      value: () => late.push("snap"),
      delta: () => {},
      resume: { cursor: () => ({ start: 0, from: 0 }), apply: () => late.push("resume") },
    })
    expect(sent).toEqual([{ t: "sub", stream: "conv:7" }])
    const socket = sockets.at(-1)
    socket?.deliver({ t: "resume", stream: "conv:7", value: { entries: [{ id: 4 }] }, start: 1 })
    socket?.deliver({ t: "snap", stream: "conv:7", value: { entries: [{ id: 1 }, { id: 4 }] } })
    expect(late).toEqual(["snap"])
    expect(early).toEqual(["resume", "snap"])
  })

  test("asks a second subscriber of a live stream for a snapshot", async () => {
    const { streams: tab } = streams()
    tab.subscribe("conv:7", { value: () => {}, delta: () => {} })
    accept = true
    tab.open()
    await advance(0)
    sent = []
    tab.subscribe("conv:7", { value: () => {}, delta: () => {} })
    expect(sent).toEqual([{ t: "sub", stream: "conv:7" }])
  })

  test("falls back to a plain sub when a server without resume refuses the frame", async () => {
    const { streams: tab } = streams()
    tab.subscribe("conv:7", {
      value: () => {},
      delta: () => {},
      resume: { cursor: () => ({ start: 3, from: 9 }), apply: () => {} },
    })
    await reconnected(tab)
    sent = []
    sockets.at(-1)?.deliver({ t: "error", message: "unknown frame" })
    expect(sent).toEqual([{ t: "sub", stream: "conv:7" }])
    sockets.at(-1)?.deliver({ t: "error", message: "unknown frame" })
    expect(sent).toHaveLength(1)
  })
})
