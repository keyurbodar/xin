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

/** Handshakes refused in a row before the tab asks `/v1/status` whether its token is still good. */
export const REFUSED_HANDSHAKES = 3

/** One socket per tab, a fresh snapshot per reconnect, resubscribed from the current view set. */
export class Streams {
  #ws: WebSocket | undefined
  #subs = new Map<string, Set<Subscription>>()
  #retry = 0
  #refused = 0
  #stopped = false
  #paused = false
  /** Bumped by every reconnect the tab asks for, so a check or a timer from before it does nothing. */
  #run = 0
  readonly #onStatus: (status: "connecting" | "open" | "closed") => void
  readonly #onSession: (socket: string | undefined) => void
  readonly #onSignedOut: () => void

  constructor(
    onStatus: (status: "connecting" | "open" | "closed") => void,
    onSession: (socket: string | undefined) => void,
    onSignedOut: () => void,
  ) {
    this.#onStatus = onStatus
    this.#onSession = onSession
    this.#onSignedOut = onSignedOut
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
    if (this.#ws !== undefined || this.#stopped || this.#paused) return
    this.#onStatus("connecting")
    const url = new URL("/v1/socket", location.href)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url, ["ingle", `bearer.${token()}`])
    this.#ws = socket
    let opened = false
    socket.addEventListener("open", () => {
      opened = true
      this.#retry = 0
      this.#refused = 0
      this.#onStatus("open")
      for (const stream of this.#subs.keys()) this.#send({ t: "sub", stream })
    })
    socket.addEventListener("message", (event) => this.#receive(event.data))
    socket.addEventListener("close", () => {
      this.#ws = undefined
      this.#onSession(undefined)
      this.#onStatus("closed")
      if (!opened) this.#refused += 1
      void this.#reconnect()
    })
    socket.addEventListener("error", () => socket.close())
  }

  /** Drops the socket so the next handshake carries the current token; subscriptions survive the bounce. */
  reconnectNow(): void {
    this.#retry = 0
    this.#refused = 0
    this.#paused = false
    this.#run += 1
    if (this.#ws === undefined) this.open()
    else this.#ws.close()
  }

  /**
   * Holds the socket closed while the owner retires this tab's token on purpose, so its refused handshakes cannot end
   * the session before the one-time replacement is copied or adopted. `reconnectNow()` resumes.
   */
  pause(): void {
    this.#paused = true
    this.#run += 1
    this.#ws?.close()
  }

  /**
   * A handshake the server refuses looks like any dropped socket, so after a run of them the tab asks once whether the
   * token still works. A 401 for the token still stored ends the session instead of redialling for the life of the tab;
   * a 401 for a token replaced meanwhile, or anything else, an offline network included, keeps the backoff.
   */
  async #reconnect(): Promise<void> {
    if (this.#paused) return
    const run = this.#run
    if (this.#refused >= REFUSED_HANDSHAKES) {
      this.#refused = 0
      const presented = token()
      const status = await fetch("/v1/status", { headers: { authorization: `Bearer ${presented}` } }).then(
        (response) => response.status,
        () => undefined,
      )
      if (run !== this.#run) return
      if (status === 401 && token() === presented) {
        this.#stopped = true
        this.#onSignedOut()
        return
      }
    }
    const delay = Math.min(15_000, 500 * 2 ** this.#retry)
    this.#retry += 1
    setTimeout(() => {
      if (run === this.#run) this.#openWhenVisible()
    }, delay)
  }

  /** A hidden tab waits to be seen before it dials again, so a dead socket in a background tab costs no requests. */
  #openWhenVisible(): void {
    if (document.visibilityState === "visible") this.open()
    else document.addEventListener("visibilitychange", () => this.#openWhenVisible(), { once: true })
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
    request.send(file)
  })
}
