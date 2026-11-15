import type { JsonObject } from "@earendil-works/pi-durable"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, ConversationView, Harness, WatchHandle } from "@earendil-works/pi-durable"
import { bool, compile, int, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema"
import type { CommandId } from "./ids.ts"
import type { Commands, Outcome } from "./ops.ts"

const context = BACKGROUND_CONTEXT
export const SNAPSHOT_ENTRIES = 60

const CommandFrame = obj({
  id: str({ minLength: 1, maxLength: 128 }),
  op: str({ minLength: 1 }),
  args: opt(unknown()),
  read: opt(bool()),
})
const ClientFrame = union([
  obj({ t: lit("cmd"), id: str({ minLength: 1, maxLength: 128 }), op: str({ minLength: 1 }), args: opt(unknown()) }),
  obj({
    t: lit("sub"),
    stream: str(),
    resume: opt(
      union([obj({ start: int({ minimum: 0 }), from: int({ minimum: 0 }) }), obj({ rev: str({ maxLength: 64 }) })]),
    ),
  }),
  obj({ t: lit("unsub"), stream: str() }),
  obj({ t: lit("typing"), conv: str(), on: bool() }),
])
const parseClient = compile(ClientFrame)
const parseCommand = compile(CommandFrame)

export type Stream = { readonly kind: "home" } | { readonly kind: "conv"; readonly id: ConversationId }

export type ServerFrame =
  | { readonly t: "ack"; readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly t: "ack"
      readonly id: string
      readonly ok: false
      readonly error: { code: string; message: string; details?: unknown }
    }
  | { readonly t: "hello"; readonly socket: string }
  | { readonly t: "snap"; readonly stream: string; readonly value: unknown; readonly rev?: string }
  | { readonly t: "resume"; readonly stream: string; readonly value?: unknown; readonly start?: number }
  | { readonly t: "ev"; readonly stream: string; readonly events: readonly unknown[] }
  | { readonly t: "error"; readonly message: string }
  | { readonly t: "changed"; readonly stream: "home"; readonly rev: string }

/** What a resubscribing client already holds: a conversation's entry ids from `start` up to `from`, or a home revision. */
type Resume = { readonly start: number; readonly from: number } | { readonly rev: string }

/** A short digest of a home snapshot, so a client that reconnects with the same one is told nothing changed. */
async function revision(value: JsonObject): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

type Attachment = {
  readonly subs: readonly string[]
  readonly id: string
  readonly since: number
  readonly origin: string
}

export type Session = { readonly id: string; readonly since: number; readonly origin: string }

const NO_ATTACHMENT: Attachment = { subs: [], id: "", since: 0, origin: "" }

function streamName(stream: Stream): string {
  return stream.kind === "home" ? "home" : `conv:${stream.id}`
}

/** `read` is the client's word that the command changes nothing, so it does not announce a home change. */
export function decodeCommand(body: unknown): { id: CommandId; op: string; args: unknown; read: boolean } | undefined {
  if (!parseCommand.check(body)) return undefined
  return { id: body.id as CommandId, op: body.op, args: body.args ?? {}, read: body.read === true }
}

export function ack(id: string, outcome: Outcome): ServerFrame {
  return outcome.kind === "ok"
    ? { t: "ack", id, ok: true, result: outcome.result }
    : {
        t: "ack",
        id,
        ok: false,
        error: {
          code: outcome.code,
          message: outcome.message,
          ...(outcome.details === undefined ? {} : { details: outcome.details }),
        },
      }
}

const read = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined

const attachment = (ws: WebSocket): Attachment => {
  let value: unknown
  try {
    value = ws.deserializeAttachment()
  } catch {
    return NO_ATTACHMENT
  }
  const subs = read(value, "subs")
  const id = read(value, "id")
  const since = read(value, "since")
  const origin = read(value, "origin")
  return {
    subs: Array.isArray(subs) ? subs.filter((sub): sub is string => typeof sub === "string") : [],
    id: typeof id === "string" ? id : "",
    since: typeof since === "number" ? since : 0,
    origin: typeof origin === "string" ? origin : "",
  }
}

const write = (ws: WebSocket, next: Attachment) => ws.serializeAttachment(next)

const send = (ws: WebSocket, frame: ServerFrame) => ws.send(JSON.stringify(frame))

export type SocketDeps = {
  readonly ctx: DurableObjectState
  readonly harness: Harness
  readonly commands: Pick<Commands, "run">
  readonly beforeWork: () => Promise<void>
  readonly typing: (conversation: ConversationId, on: boolean) => Promise<void>
  readonly home: () => Promise<JsonObject>
}

export class Sockets {
  readonly #watches = new Map<ConversationId, Promise<WatchHandle<ConversationView>>>()
  /** The newest value of each shared watch, which every subscriber's deltas apply to. */
  readonly #latest = new Map<ConversationId, ConversationView>()

  constructor(private readonly deps: SocketDeps) {
    deps.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"_tag":"Ping"}', '{"_tag":"Pong"}'))
  }

  accept(protocol: string | undefined, origin: string): Response {
    const { 0: client, 1: server } = new WebSocketPair()
    this.deps.ctx.acceptWebSocket(server)
    const id = crypto.randomUUID()
    server.serializeAttachment({ subs: [], id, since: Date.now(), origin } satisfies Attachment)
    send(server, { t: "hello", socket: id })
    const headers = protocol === undefined ? undefined : { "sec-websocket-protocol": protocol }
    return new Response(null, { status: 101, webSocket: client, ...(headers === undefined ? {} : { headers }) })
  }

  list(): Session[] {
    return this.deps.ctx
      .getWebSockets()
      .map((ws) => attachment(ws))
      .toSorted((left, right) => left.since - right.since)
      .map(({ id, since, origin }) => ({ id, since, origin }))
  }

  close(id: string | undefined): number {
    const targets = this.deps.ctx.getWebSockets().filter((ws) => id === undefined || attachment(ws).id === id)
    for (const ws of targets) {
      try {
        ws.close(1000, "signed out")
      } catch {
        // A socket already closing counts as handled.
      }
    }
    return targets.length
  }

  async rehydrate(): Promise<void> {
    const ids = new Set(this.deps.ctx.getWebSockets().flatMap((ws) => attachment(ws).subs))
    for (const name of ids) {
      const stream = await this.#resolve(name)
      if (stream?.kind === "conv") await this.#watch(stream.id)
    }
  }

  async message(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let frame: unknown
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
    } catch {
      return send(ws, { t: "error", message: "frame is not JSON" })
    }
    if (!parseClient.check(frame)) return send(ws, { t: "error", message: "unknown frame" })
    switch (frame.t) {
      case "cmd": {
        await this.deps.beforeWork()
        const outcome = await this.deps.commands.run(
          { id: frame.id as CommandId, op: frame.op, args: frame.args ?? {} },
          { kind: "owner" },
        )
        return send(ws, ack(frame.id, outcome))
      }
      case "sub":
        return this.#subscribe(ws, frame.stream, frame.resume)
      case "unsub":
        return this.#unsubscribe(ws, frame.stream)
      case "typing": {
        const stream = await this.#resolve(`conv:${frame.conv}`)
        if (stream?.kind === "conv") await this.deps.typing(stream.id, frame.on)
        return
      }
      default: {
        const _exhaustive: never = frame
        throw new Error(`unhandled frame ${JSON.stringify(_exhaustive)}`)
      }
    }
  }

  async closed(ws: WebSocket): Promise<void> {
    for (const name of attachment(ws).subs) await this.#unsubscribe(ws, name)
  }

  /** Tells every home subscriber that owner state changed, so its read cache is stale; carries no state. */
  publishChanged(rev: string): void {
    for (const ws of this.#subscribers("home")) send(ws, { t: "changed", stream: "home", rev })
  }

  async publishHome(): Promise<void> {
    const value = await this.deps.home()
    const rev = await revision(value)
    for (const ws of this.#subscribers("home")) send(ws, { t: "snap", stream: "home", value, rev })
  }

  async #resolve(name: string): Promise<Stream | undefined> {
    if (name === "home") return { kind: "home" }
    const match = /^conv:(\d+)$/.exec(name)
    if (match === null) return undefined
    const conversation = await this.deps.harness.conversation(Number(match[1]) as ConversationId, context)
    return conversation === undefined ? undefined : { kind: "conv", id: conversation.id }
  }

  /**
   * A first subscribe gets a snapshot. A resubscribe that says what it holds gets only what it lacks: for the home,
   * nothing when its revision is current; for a conversation, the entries from `from` on, when what it holds reaches
   * back to the start of the shared window its deltas will apply to. Anything else falls back to a snapshot.
   */
  async #subscribe(ws: WebSocket, name: string, resume: Resume | undefined): Promise<void> {
    const stream = await this.#resolve(name)
    if (stream === undefined) return send(ws, { t: "error", message: `unknown stream ${name}` })
    const current = attachment(ws)
    if (!current.subs.includes(name)) write(ws, { ...current, subs: [...current.subs, name] })
    if (stream.kind === "home") {
      const value = await this.deps.home()
      const rev = await revision(value)
      if (resume !== undefined && "rev" in resume && resume.rev === rev) return send(ws, { t: "resume", stream: name })
      return send(ws, { t: "snap", stream: name, value, rev })
    }
    await this.#watch(stream.id)
    const value = this.#latest.get(stream.id)
    if (value === undefined) return send(ws, { t: "error", message: `stream ${name} failed` })
    const start = value.entries[0]?.id
    if (resume !== undefined && "from" in resume && (start === undefined || resume.start <= start))
      return send(ws, {
        t: "resume",
        stream: name,
        value: { ...value, entries: value.entries.filter((entry) => entry.id >= resume.from) },
        ...(start === undefined ? {} : { start }),
      })
    send(ws, { t: "snap", stream: name, value })
  }

  async #unsubscribe(ws: WebSocket, name: string): Promise<void> {
    const current = attachment(ws)
    write(ws, { ...current, subs: current.subs.filter((sub) => sub !== name) })
    const stream = await this.#resolve(name)
    if (stream?.kind !== "conv" || this.#subscribers(name).length > 0) return
    const watch = this.#watches.get(stream.id)
    this.#watches.delete(stream.id)
    this.#latest.delete(stream.id)
    await (await watch)?.stop()
  }

  #subscribers(name: string): WebSocket[] {
    return this.deps.ctx.getWebSockets().filter((ws) => attachment(ws).subs.includes(name))
  }

  #watch(id: ConversationId): Promise<WatchHandle<ConversationView>> {
    const existing = this.#watches.get(id)
    if (existing !== undefined) return existing
    const name = streamName({ kind: "conv", id })
    const started = this.deps.harness
      .conversation(id, context)
      .then((conversation) => {
        if (conversation === undefined) throw new Error(`conversation ${id} is gone`)
        return conversation.watch(context, { min: SNAPSHOT_ENTRIES, max: SNAPSHOT_ENTRIES * 2 })
      })
      .then((watch) => {
        this.#latest.set(id, watch.value)
        watch.start(async (call) => {
          if (call.kind === "failed") {
            this.#watches.delete(id)
            this.#latest.delete(id)
            for (const ws of this.#subscribers(name)) send(ws, { t: "error", message: `stream ${name} failed` })
            return
          }
          this.#latest.set(id, call.value)
          for (const ws of this.#subscribers(name)) send(ws, { t: "ev", stream: name, events: call.ops })
        })
        return watch
      })
    this.#watches.set(id, started)
    return started
  }
}
