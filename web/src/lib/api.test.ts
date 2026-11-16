import { afterEach, beforeEach, expect, test } from "bun:test"
import { installGlobal, snapshotGlobals } from "../../test/globals.ts"
import { repair, Streams } from "./api.ts"

type Listener = () => void

class FakeSocket {
  static opened: FakeSocket[] = []
  readonly listeners = new Map<string, Listener[]>()
  readyState = 0

  constructor() {
    FakeSocket.opened.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(): void {}

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) listener()
  }
}

const timers = new Map<number, () => void>()
const waiting = new Set<Listener>()
let nextTimer = 1
let visibility: "visible" | "hidden" = "visible"
let restore = (): void => undefined

beforeEach(() => {
  restore = snapshotGlobals(["fetch", "setTimeout", "clearTimeout", "WebSocket", "document", "location"])
  FakeSocket.opened = []
  timers.clear()
  waiting.clear()
  visibility = "visible"
  installGlobal("WebSocket", FakeSocket)
  installGlobal("location", { href: "http://127.0.0.1:5199/" })
  installGlobal("document", {
    get visibilityState() {
      return visibility
    },
    addEventListener: (_type: string, listener: Listener) => waiting.add(listener),
    removeEventListener: (_type: string, listener: Listener) => waiting.delete(listener),
  })
  installGlobal("setTimeout", (run: () => void) => {
    const id = nextTimer++
    timers.set(id, run)
    return id
  })
  installGlobal("clearTimeout", (id: number | undefined) => {
    if (id !== undefined) timers.delete(id)
  })
})

afterEach(() => {
  restore()
})

const quiet = (): Streams => new Streams(() => {}, () => {}, () => {}, () => {}, () => {})

function fire(): void {
  const [id, run] = [...timers.entries()][0] ?? []
  if (id === undefined || run === undefined) throw new Error("no pending dial")
  timers.delete(id)
  run()
}

test("reconnects and online events during an outage leave one pending dial, never a second chain", () => {
  const streams = quiet()
  streams.open()
  FakeSocket.opened[0]?.close()
  expect(timers.size).toBe(1)

  streams.dialNow()
  streams.dialNow()
  streams.dialNow()
  expect(FakeSocket.opened.length).toBe(2)
  expect(timers.size).toBe(0)

  FakeSocket.opened[1]?.close()
  expect(timers.size).toBe(1)
  streams.dialNow()
  FakeSocket.opened[2]?.close()
  streams.dialNow()
  FakeSocket.opened[3]?.close()
  expect(timers.size).toBe(1)
  fire()
  expect(FakeSocket.opened.length).toBe(5)
  expect(timers.size).toBe(0)
})

test("a hidden tab's wait for visibility is dropped when a dial starts, so it cannot dial again later", () => {
  const streams = quiet()
  streams.open()
  FakeSocket.opened[0]?.close()
  visibility = "hidden"
  fire()
  expect(waiting.size).toBe(1)
  visibility = "visible"
  streams.dialNow()
  expect(waiting.size).toBe(0)
  expect(FakeSocket.opened.length).toBe(2)
})

test("repair posts no body for a report and the drop for a repair, with the bearer token", async () => {
  const sent: { method: string | undefined; body: unknown; auth: string | null }[] = []
  installGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push({
      method: init.method,
      body: init.body,
      auth: new Headers(init.headers).get("authorization"),
    })
    return new Response(JSON.stringify({ failure: null, journal: 0, checkpoint: 0 }), { status: 200 })
  })
  expect(await repair()).toEqual({ kind: "report", report: { failure: null, journal: 0, checkpoint: 0 } })
  await repair("journal")
  expect(sent.map((call) => [call.method, call.body])).toEqual([
    ["POST", undefined],
    ["POST", JSON.stringify({ drop: "journal" })],
  ])
  expect(sent[0]?.auth).toMatch(/^Bearer/)
})
