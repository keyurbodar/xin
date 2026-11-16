import { type Context, Service } from "@deepseek-ai/cordis"
import type { JsonObject } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { messageOf } from "../errors.ts"
import { ack, decodeCommand, type ServerFrame, Sockets } from "../wire.ts"
import { hidden } from "./hidden.ts"

type HomePart = () => Promise<JsonObject>

const OWNER = ["owner"] as const

/** Commands one `POST /v1/cmd` may carry; they run in order, each with its own receipt. */
export const MAX_BATCH = 32

type State = {
  readonly parts: Map<string, HomePart>
  sockets: Sockets | undefined
  /** The home revision: in memory only, with a per-instance epoch so a fresh instance never repeats an old value. */
  readonly epoch: string
  changes: number
  /** Home snapshots published so far: a batch that published one needs no separate `changed` frame. */
  published: number
  /** HTTP batches running now: their changes are told once, when the last one ends. */
  batches: number
  /** A change not yet told to home subscribers. */
  untold: boolean
  /** A tell is queued for the end of this tick. */
  queued: boolean
}

const state = hidden<Wire, State>()

/** Tells home subscribers the newest revision, once for however many changes came since the last tell. */
function tell(held: State): void {
  if (!held.untold || held.batches > 0) return
  held.untold = false
  held.sockets?.publishChanged(`${held.epoch}.${held.changes}`)
}

const socketsOf = (wire: Wire): Sockets | undefined => state.get(wire).sockets

export class Wire extends Service {
  static readonly inject = ["host", "ops", "http", "clock", "db"]

  constructor(ctx: Context) {
    super(ctx, "wire")
    state.set(this, {
      parts: new Map(),
      sockets: undefined,
      epoch: crypto.randomUUID().slice(0, 8),
      changes: 0,
      published: 0,
      batches: 0,
      untold: false,
      queued: false,
    })
    ctx.http.route("POST /v1/cmd", async (request) => {
      const body: unknown = await request.json().catch(() => undefined)
      const batch = Array.isArray(body)
      const frames: readonly unknown[] = Array.isArray(body) ? body : [body]
      if (frames.length === 0 || frames.length > MAX_BATCH)
        return Response.json({ error: `a batch holds 1 to ${MAX_BATCH} commands` }, { status: 400 })
      const commands = frames.flatMap((frame) => decodeCommand(frame) ?? [])
      if (commands.length !== frames.length) return Response.json({ error: "bad command frame" }, { status: 400 })
      await ctx.clock.arm()
      const acks: ServerFrame[] = []
      let wrote = false
      let broken: string | undefined
      const held = state.get(this)
      const published = held.published
      held.batches += 1
      try {
        for (const command of commands) {
          if (broken !== undefined) {
            acks.push({ t: "ack", id: command.id, ok: false, error: { code: "not_run", message: broken } })
            continue
          }
          if (!ctx.ops.reads(command.op)) wrote = true
          try {
            acks.push(ack(command.id, await ctx.ops.run(command, { kind: "owner" })))
          } catch (error) {
            broken = `an earlier command threw: ${messageOf(error)}`
            acks.push({ t: "ack", id: command.id, ok: false, error: { code: "failed", message: messageOf(error) } })
          }
        }
      } finally {
        held.batches -= 1
      }
      const headers = wrote ? { "x-ingle-rev": this.announce() } : undefined
      if (held.published !== published) held.untold = false
      tell(held)
      return Response.json(batch ? acks : acks[0], headers === undefined ? {} : { headers })
    })
    ctx.http.route("POST /v1/auth", async () => new Response(null, { status: 204 }))
    ctx.http.route("GET /v1/socket", async (request) => {
      const sockets = socketsOf(this)
      if (request.headers.get("upgrade") !== "websocket" || sockets === undefined)
        return new Response("not found", { status: 404 })
      return sockets.accept(request.headers.get("x-ingle-protocol") ?? undefined, request.headers.get("origin") ?? "")
    })
    ctx.ops.define(
      defineOp({
        name: "session.list",
        read: true,
        args: obj({}),
        actors: OWNER,
        run: async () => socketsOf(this)?.list() ?? [],
      }),
    )
    ctx.ops.define(
      defineOp({
        name: "session.close",
        args: obj({ id: opt(str({ minLength: 1 })) }),
        actors: OWNER,
        run: async (_api, args) => ({ closed: socketsOf(this)?.close(args.id) ?? 0 }),
      }),
    )
    ctx.ops.define(
      defineOp({
        name: "session.rotate",
        args: obj({}),
        actors: OWNER,
        run: async () => {
          const token = await ctx.host.auth.rotate(ctx.db)
          socketsOf(this)?.close(undefined)
          return { token }
        },
      }),
    )
    ctx.inject(["harness"], async (inner) => {
      const sockets = new Sockets({
        ctx: ctx.host.state,
        harness: inner.harness,
        commands: ctx.ops,
        beforeWork: () => ctx.clock.arm(),
        typing: (conversation, on) => ctx.parallel("wire/typing", conversation, on),
        home: () => this.snapshot(),
      })
      inner.effect(() => {
        state.get(this).sockets = sockets
        return () => {
          state.get(this).sockets = undefined
        }
      })
      await sockets.rehydrate()
    })
  }

  /**
   * Owner state changed (a batch that ran a non-read op, or an agent's write): moves the revision on and returns it.
   * Home subscribers hear one `changed` frame per batch, or per tick for changes outside a batch, so tabs drop their
   * cached reads once however many writes landed.
   */
  announce(): string {
    const held = state.get(this)
    held.changes += 1
    held.untold = true
    if (!held.queued) {
      held.queued = true
      setTimeout(() => {
        held.queued = false
        tell(held)
      }, 0)
    }
    return `${held.epoch}.${held.changes}`
  }

  home(part: string, read: HomePart): () => void {
    const { parts } = state.get(this)
    return this.ctx.effect(() => {
      if (parts.has(part)) throw new Error(`home part ${part} is already registered`)
      parts.set(part, read)
      return () => {
        if (parts.get(part) === read) parts.delete(part)
      }
    }, `wire.home(${part})`)
  }

  async snapshot(): Promise<JsonObject> {
    const parts = await Promise.all([...state.get(this).parts.values()].map((read) => read()))
    return Object.assign({}, ...parts)
  }

  async publishHome(): Promise<void> {
    state.get(this).published += 1
    await socketsOf(this)?.publishHome()
  }

  /** A frame from an accepted socket. The host alone delivers these: a frame runs its command as the owner. */
  async message(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await socketsOf(this)?.message(ws, raw)
  }

  async closed(ws: WebSocket): Promise<void> {
    await socketsOf(this)?.closed(ws)
  }
}
