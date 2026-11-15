import { type Context, Service } from "@deepseek-ai/cordis"
import type { JsonObject } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { ack, decodeCommand, Sockets } from "../wire.ts"
import { hidden } from "./hidden.ts"
import type { IngleLoader } from "./loader.ts"

type HomePart = () => Promise<JsonObject>

const OWNER = ["owner"] as const

type State = {
  readonly own: Context
  readonly parts: Map<string, HomePart>
  sockets: Sockets | undefined
}

const state = hidden<Wire, State>()

const kernelOf = (wire: Wire): IngleLoader | undefined => state.get(wire).own.get("kernel")

const socketsOf = (wire: Wire): Sockets | undefined => state.get(wire).sockets

export class Wire extends Service {
  static readonly inject = ["host", "ops", "http", "clock", "db"]

  constructor(ctx: Context) {
    super(ctx, "wire")
    state.set(this, { own: ctx, parts: new Map(), sockets: undefined })
    ctx.http.route("POST /v1/cmd", async (request) => {
      const command = decodeCommand(await request.json().catch(() => undefined))
      if (command === undefined) return Response.json({ error: "bad command frame" }, { status: 400 })
      await ctx.clock.arm()
      return Response.json(ack(command.id, await ctx.ops.run(command, { kind: "owner" })))
    })
    ctx.http.route("POST /v1/auth", async () => new Response(null, { status: 204 }))
    ctx.http.route("GET /v1/socket", async (request) => {
      const sockets = socketsOf(this)
      if (request.headers.get("upgrade") !== "websocket" || sockets === undefined)
        return new Response("not found", { status: 404 })
      return sockets.accept(request.headers.get("x-ingle-protocol") ?? undefined, request.headers.get("origin") ?? "")
    })
    ctx.ops.define(
      defineOp({ name: "session.list", args: obj({}), actors: OWNER, run: async () => socketsOf(this)?.list() ?? [] }),
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
    await socketsOf(this)?.publishHome()
  }

  /** A frame from an accepted socket. The host alone delivers these: a frame runs its command as the owner. */
  async message(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    kernelOf(this)?.kernelOnly(this.ctx.fiber, "deliver socket frames")
    await socketsOf(this)?.message(ws, raw)
  }

  async closed(ws: WebSocket): Promise<void> {
    kernelOf(this)?.kernelOnly(this.ctx.fiber, "close sockets")
    await socketsOf(this)?.closed(ws)
  }
}
