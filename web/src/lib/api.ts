import { token } from "./auth.ts"
import { parseRepairReply, type Drop, type RepairAnswer } from "./repair.ts"

export class OpError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "OpError"
  }
}

/** A rejection the host recorded against this command id; a retry with the same id replays it, so the next attempt needs a new id. */
export function isDefinitive(problem: unknown): boolean {
  return problem instanceof OpError && problem.code !== "http"
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
  | { readonly t: "hello"; readonly socket: string }
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
  #timer: ReturnType<typeof setTimeout> | undefined
  #waiting: (() => void) | undefined
  readonly #onStatus: (status: "connecting" | "open" | "closed") => void
  readonly #onSession: (socket: string | undefined) => void
  readonly #onRetry: (at: number) => void

  constructor(
    onStatus: (status: "connecting" | "open" | "closed") => void,
    onSession: (socket: string | undefined) => void,
    onRetry: (at: number) => void,
  ) {
    this.#onStatus = onStatus
    this.#onSession = onSession
    this.#onRetry = onRetry
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
    if (this.#ws !== undefined) return
    this.#cancelPending()
    this.#onStatus("connecting")
    const url = new URL("/v1/socket", location.href)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url, ["ingle", `bearer.${token()}`])
    this.#ws = socket
    socket.addEventListener("open", () => {
      this.#retry = 0
      this.#onStatus("open")
      for (const stream of this.#subs.keys()) this.#send({ t: "sub", stream })
    })
    socket.addEventListener("message", (event) => this.#receive(event.data))
    socket.addEventListener("close", () => {
      this.#ws = undefined
      this.#onSession(undefined)
      this.#onStatus("closed")
      this.#reconnect()
    })
    socket.addEventListener("error", () => socket.close())
  }

  /** Drops the socket so the next handshake carries the current token, or dials at once when none is open. */
  reconnectNow(): void {
    this.#retry = 0
    if (this.#ws === undefined) this.open()
    else this.#ws.close()
  }

  /** Dials now in place of the pending backoff; a dial already in flight is left to finish, so there is one chain. */
  dialNow(): void {
    this.#retry = 0
    this.open()
  }

  #cancelPending(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#waiting === undefined) return
    document.removeEventListener("visibilitychange", this.#waiting)
    this.#waiting = undefined
  }

  #reconnect(): void {
    this.#cancelPending()
    const delay = Math.min(15_000, 500 * 2 ** this.#retry)
    this.#retry += 1
    this.#onRetry(Date.now() + delay)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#openWhenVisible()
    }, delay)
  }

  /** A hidden tab waits to be seen before it dials again, so a dead socket in a background tab costs no requests. */
  #openWhenVisible(): void {
    if (document.visibilityState === "visible") {
      this.open()
      return
    }
    const waiting = (): void => {
      this.#waiting = undefined
      this.#openWhenVisible()
    }
    this.#waiting = waiting
    document.addEventListener("visibilitychange", waiting, { once: true })
  }

  #send(frame: Record<string, unknown>): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame))
  }

  #receive(raw: unknown): void {
    if (typeof raw !== "string") return
    const frame = parseFrame(raw)
    if (frame === undefined) return
    if (frame.t === "hello") {
      this.#onSession(frame.socket)
      return
    }
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
  if (t === "snap" || t === "ev" || t === "ack" || t === "error" || t === "hello") return value as ServerFrame
  return undefined
}

/** The one route a home that cannot boot still answers. Without `drop` it only reports what is stored. */
export async function repair(drop?: Drop): Promise<RepairAnswer> {
  const response = await fetch("/v1/repair", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    ...(drop === undefined ? {} : { body: JSON.stringify({ drop }) }),
  })
  return parseRepairReply(response)
}

export type UploadedFile = {
  readonly path: string
  readonly name: string
  readonly type: string
  readonly size: number
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export function uploadFile(
  file: File,
  folder: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const safe = file.name.replace(/[^\w.\-]+/gu, "-").slice(-80)
  const type = file.type === "" ? "application/octet-stream" : file.type
  const path = `${folder.replace(/\/+$/gu, "")}/${Date.now().toString(36)}-${safe}`
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("PUT", `/files${path}`)
    request.setRequestHeader("authorization", `Bearer ${token()}`)
    request.setRequestHeader("content-type", type)
    if (onProgress !== undefined)
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
      }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve({ path, name: file.name, type, size: file.size })
      else reject(new OpError("upload", `${file.name}: HTTP ${request.status}`))
    }
    request.onerror = () => reject(new OpError("upload", `${file.name}: the upload did not reach the Worker`))
    request.onabort = () => reject(new OpError("aborted", `${file.name}: upload cancelled`))
    if (signal?.aborted === true) {
      reject(new OpError("aborted", `${file.name}: upload cancelled`))
      return
    }
    signal?.addEventListener("abort", () => request.abort(), { once: true })
    request.send(file)
  })
}
