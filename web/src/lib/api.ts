import { token } from "./auth.ts"

export class OpError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "OpError"
  }
}

type Ack<T> =
  | { readonly t: "ack"; readonly id: string; readonly ok: true; readonly result: T }
  | { readonly t: "ack"; readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** A caller that may retry passes its own command id: the host dedupes on it, so a replay lands once. */
export type CmdOptions = { readonly id?: string }

export async function cmd<T>(op: string, args: Record<string, unknown> = {}, options: CmdOptions = {}): Promise<T> {
  const response = await fetch("/v1/cmd", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify({ id: options.id ?? crypto.randomUUID(), op, args }),
  })
  if (!response.ok) throw new OpError("http", `${op}: HTTP ${response.status}`)
  const body = (await response.json()) as Ack<T>
  if (!body.ok) throw new OpError(body.error.code, body.error.message)
  return body.result
}

export type ServerFrame =
  | { readonly t: "ack"; readonly id: string; readonly ok: boolean; readonly result?: unknown; readonly error?: { code: string; message: string } }
  | { readonly t: "snap"; readonly stream: string; readonly value: unknown }
  | { readonly t: "ev"; readonly stream: string; readonly events: readonly unknown[] }
  | { readonly t: "error"; readonly message: string }

export type StreamListener = (value: unknown) => void
export type DeltaListener = (events: readonly unknown[]) => void

type Subscription = {
  readonly value: StreamListener
  readonly delta: DeltaListener
}

/** One socket per tab, a fresh snapshot per reconnect, resubscribed from the current view set. */
export class Streams {
  #ws: WebSocket | undefined
  #subs = new Map<string, Set<Subscription>>()
  #retry = 0
  #closed = false
  readonly #onStatus: (status: "connecting" | "open" | "closed") => void

  constructor(onStatus: (status: "connecting" | "open" | "closed") => void) {
    this.#onStatus = onStatus
  }

  subscribe(stream: string, subscription: Subscription): () => void {
    const set = this.#subs.get(stream) ?? new Set<Subscription>()
    this.#subs.set(stream, set)
    set.add(subscription)
    if (set.size === 1) this.#send({ t: "sub", stream })
    return () => {
      set.delete(subscription)
      if (set.size === 0) {
        this.#subs.delete(stream)
        this.#send({ t: "unsub", stream })
      }
    }
  }

  open(): void {
    if (this.#ws !== undefined || this.#closed) return
    this.#onStatus("connecting")
    const url = new URL("/v1/socket", location.href)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url, ["xin", `bearer.${token()}`])
    this.#ws = socket
    socket.addEventListener("open", () => {
      this.#retry = 0
      this.#onStatus("open")
      for (const stream of this.#subs.keys()) this.#send({ t: "sub", stream })
    })
    socket.addEventListener("message", (event) => this.#receive(event.data))
    socket.addEventListener("close", () => {
      this.#ws = undefined
      this.#onStatus("closed")
      this.#reconnect()
    })
    socket.addEventListener("error", () => socket.close())
  }

  close(): void {
    this.#closed = true
    this.#ws?.close()
    this.#ws = undefined
  }

  #reconnect(): void {
    if (this.#closed) return
    const delay = Math.min(15_000, 500 * 2 ** this.#retry)
    this.#retry += 1
    setTimeout(() => this.open(), delay)
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame))
  }

  #receive(raw: unknown): void {
    if (typeof raw !== "string") return
    const frame = parseFrame(raw)
    if (frame === undefined) return
    if (frame.t === "snap") {
      for (const sub of this.#subs.get(frame.stream) ?? []) sub.value(frame.value)
      return
    }
    if (frame.t === "ev") {
      for (const sub of this.#subs.get(frame.stream) ?? []) sub.delta(frame.events)
    }
  }
}

function parseFrame(raw: string): ServerFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const t = Reflect.get(value, "t")
  if (t === "snap" || t === "ev" || t === "ack" || t === "error") return value as ServerFrame
  return undefined
}
