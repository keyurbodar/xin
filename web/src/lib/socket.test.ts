import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { REFUSED_HANDSHAKES, Streams } from "./api.ts"

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

  send(): void {}

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.#emit("close", {})
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

const saved = Object.fromEntries(
  ["fetch", "setTimeout", "clearTimeout", "WebSocket", "document", "location", "localStorage"].map((name) => [
    name,
    Reflect.get(globalThis, name),
  ]),
)

function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

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
  requests = []
  dialled = []
  statusReply = 401
  accept = false
  stored = "own_revoked"
  pending = undefined
  hold = false
  now = 0
  timers = []
  install("WebSocket", FakeSocket)
  install("location", { href: "https://ingle.test/" })
  install("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} })
  install("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value
    },
    removeItem: () => {
      stored = ""
    },
  })
  install("setTimeout", (run: () => void, delay = 0) => {
    const id = nextId++
    timers.push({ id, at: now + delay, run })
    return id
  })
  install("clearTimeout", (id: number | undefined) => {
    timers = timers.filter((timer) => timer.id !== id)
  })
  install("fetch", async (input: string, init?: { headers?: Record<string, string> }) => {
    requests.push(`fetch ${input} ${init?.headers?.["authorization"] ?? ""}`.trim())
    const status = hold ? await new Promise<number>((resolve) => (pending = resolve)) : statusReply
    return new Response(null, { status })
  })
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) install(name, value)
})

const HOUR = 60 * 60_000

function streams(): { streams: Streams; signedOut: () => number } {
  let count = 0
  const made = new Streams(
    () => {},
    () => {},
    () => {},
    () => {
      count += 1
    },
  )
  return { streams: made, signedOut: () => count }
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
