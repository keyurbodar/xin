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

/** Commands one `POST /v1/cmd` may carry; the host refuses more. */
export const MAX_BATCH = 32

type Queued = {
  readonly frame: { readonly id: string; readonly op: string; readonly args: Record<string, unknown> }
  resolve(ack: Ack<unknown>): void
  reject(error: unknown): void
}

let queue: Queued[] = []

/** Commands issued in the same task go out as one request: one Worker request and one home request for all of them. */
async function flush(): Promise<void> {
  const batch = queue.splice(0, MAX_BATCH)
  if (queue.length > 0) queueMicrotask(() => void flush())
  if (batch.length === 0) return
  const single = batch.length === 1
  try {
    const response = await fetch("/v1/cmd", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
      body: JSON.stringify(single ? batch[0]?.frame : batch.map((queued) => queued.frame)),
    })
    if (!response.ok) throw new OpError("http", `${batch.map((queued) => queued.frame.op).join(", ")}: HTTP ${response.status}`)
    const body: unknown = await response.json()
    const acks = (Array.isArray(body) ? body : [body]) as Ack<unknown>[]
    const byId = new Map(acks.map((ack) => [ack.id, ack]))
    for (const queued of batch) {
      const ack = byId.get(queued.frame.id)
      if (ack === undefined) queued.reject(new OpError("http", `${queued.frame.op}: no ack`))
      else queued.resolve(ack)
    }
  } catch (error: unknown) {
    for (const queued of batch) queued.reject(error)
  }
}

function send<T>(op: string, args: Record<string, unknown>, options: CmdOptions): Promise<T> {
  return new Promise<Ack<unknown>>((resolve, reject) => {
    if (queue.length === 0) queueMicrotask(() => void flush())
    queue.push({ frame: { id: options.id ?? crypto.randomUUID(), op, args }, resolve, reject })
  }).then((ack) => {
    if (!ack.ok) throw new OpError(ack.error.code, ack.error.message)
    return ack.result as T
  })
}

/** Read results by op and args, kept until something may have changed them. */
const reads = new Map<string, Promise<unknown>>()

/** Drops every cached read: called after a command succeeds and whenever the home stream says the home changed. */
export function invalidateReads(): void {
  reads.clear()
}

/** A command that may change state; once it succeeds, cached reads are dropped. */
export async function cmd<T>(op: string, args: Record<string, unknown> = {}, options: CmdOptions = {}): Promise<T> {
  const result = await send<T>(op, args, options)
  invalidateReads()
  return result
}

/**
 * A read that changes nothing, answered from the cache while no command or home change has dropped it. Concurrent
 * callers share one request, so screens that open together fire each read once.
 */
export function cached<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const key = `${op}\u0000${JSON.stringify(args)}`
  const hit = reads.get(key)
  if (hit !== undefined) return hit as Promise<T>
  const started = send<T>(op, args, {})
  reads.set(key, started)
  started.catch(() => {
    if (reads.get(key) === started) reads.delete(key)
  })
  return started
}

export type ServerFrame =
  | { readonly t: "hello"; readonly socket: string }
  | { readonly t: "ack"; readonly id: string; readonly ok: boolean; readonly result?: unknown; readonly error?: { code: string; message: string } }
  | { readonly t: "snap"; readonly stream: string; readonly value: unknown; readonly rev?: string }
  | { readonly t: "resume"; readonly stream: string; readonly value?: unknown; readonly start?: number }
  | { readonly t: "ev"; readonly stream: string; readonly events: readonly unknown[] }
  | { readonly t: "error"; readonly message: string }

export type StreamListener = (value: unknown, rev: string | undefined) => void
export type DeltaListener = (events: readonly unknown[]) => void

/** What a subscriber already holds, sent on a resubscribe so the server answers with only what is missing. */
export type ResumeCursor = { readonly start: number; readonly from: number } | { readonly rev: string }

export type Resumable = {
  cursor(): ResumeCursor | undefined
  /** The server's answer to the cursor: what changed since it, and where the shared window now starts. */
  apply(value: unknown, start: number | undefined): void
}

export type Subscription = {
  readonly value: StreamListener
  readonly delta: DeltaListener
  readonly resume?: Resumable
}

/** Handshakes refused in a row before the tab asks `/v1/status` whether its token is still good. */
export const REFUSED_HANDSHAKES = 3

/** One socket per tab; a reconnect resubscribes the current view set from what each view already holds. */
export class Streams {
  #ws: WebSocket | undefined
  #subs = new Map<string, Set<Subscription>>()
  #retry = 0
  #refused = 0
  #stopped = false
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
    if (this.#ws !== undefined || this.#stopped) return
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
      for (const [stream, subs] of this.#subs) {
        const resume = cursorOf(subs)
        this.#send(resume === undefined ? { t: "sub", stream } : { t: "sub", stream, resume })
      }
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
    this.#ws?.close()
  }

  /**
   * A handshake the server refuses looks like any dropped socket, so after a run of them the tab asks once whether the
   * token still works. A 401 ends the session instead of redialling for the life of the tab; anything else, an offline
   * network included, keeps the backoff and starts a new run.
   */
  async #reconnect(): Promise<void> {
    if (this.#refused >= REFUSED_HANDSHAKES) {
      this.#refused = 0
      const status = await fetch("/v1/status", { headers: { authorization: `Bearer ${token()}` } }).then(
        (response) => response.status,
        () => undefined,
      )
      if (status === 401) {
        this.#stopped = true
        this.#onSignedOut()
        return
      }
    }
    const delay = Math.min(15_000, 500 * 2 ** this.#retry)
    this.#retry += 1
    setTimeout(() => this.#openWhenVisible(), delay)
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
      if (frame.stream === "home") invalidateReads()
      for (const sub of this.#subs.get(frame.stream) ?? []) sub.value(frame.value, frame.rev)
      return
    }
    if (frame.t === "resume") {
      for (const sub of this.#subs.get(frame.stream) ?? []) sub.resume?.apply(frame.value, frame.start)
      return
    }
    if (frame.t === "ev") {
      for (const sub of this.#subs.get(frame.stream) ?? []) sub.delta(frame.events)
    }
  }
}

/** Subscribers of one stream share its frames, so a cursor is only sent when every one of them can resume. */
function cursorOf(subs: ReadonlySet<Subscription>): ResumeCursor | undefined {
  const cursors = [...subs].map((sub) => sub.resume?.cursor())
  const first = cursors[0]
  if (first === undefined || cursors.some((cursor) => JSON.stringify(cursor) !== JSON.stringify(first))) return undefined
  return first
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
  if (t === "snap" || t === "resume" || t === "ev" || t === "ack" || t === "error" || t === "hello") return value as ServerFrame
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
