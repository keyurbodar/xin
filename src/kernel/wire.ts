import { type Context, Service } from "@deepseek-ai/cordis"
import type { JsonObject } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { ack, decodeCommand, Sockets } from "../wire.ts"

type HomePart = () => Promise<JsonObject>

const OWNER = ["owner"] as const

export class Wire extends Service {
  static readonly inject = ["host", "ops", "http", "clock"]

  readonly parts = new Map<string, HomePart>()
  sockets: Sockets | undefined

  constructor(ctx: Context) {
    super(ctx, "wire")
    ctx.http.route("POST /v1/cmd", async (request) => {
      const command = decodeCommand(await request.json().catch(() => undefined))
      if (command === undefined) return Response.json({ error: "bad command frame" }, { status: 400 })
      await ctx.clock.arm()
      return Response.json(ack(command.id, await ctx.ops.run(command, { kind: "owner" })))
    })
    ctx.http.route("GET /v1/socket", async (request) => {
      if (request.headers.get("upgrade") !== "websocket" || this.sockets === undefined)
        return new Response("not found", { status: 404 })
      return this.sockets.accept(
        request.headers.get("x-xin-protocol") ?? undefined,
        request.headers.get("origin") ?? "",
      )
    })
    ctx.ops.define(
      defineOp({ name: "session.list", args: obj({}), actors: OWNER, run: async () => this.sockets?.list() ?? [] }),
    )
    ctx.ops.define(
      defineOp({
        name: "session.close",
        args: obj({ id: opt(str({ minLength: 1 })) }),
        actors: OWNER,
        run: async (_api, args) => ({ closed: this.sockets?.close(args.id) ?? 0 }),
      }),
    )
    ctx.inject(["harness"], async (inner) => {
      const sockets = new Sockets({
        ctx: ctx.host.state,
        harness: inner.harness,
        commands: ctx.ops.commands,
        beforeWork: () => ctx.clock.arm(),
        typing: (conversation, on) => ctx.parallel("wire/typing", conversation, on),
        home: () => this.snapshot(),
      })
      inner.effect(() => {
        this.sockets = sockets
        return () => {
          this.sockets = undefined
        }
      })
      await sockets.rehydrate()
    })
  }

  home(part: string, read: HomePart): () => void {
    return this.ctx.effect(() => {
      if (this.parts.has(part)) throw new Error(`home part ${part} is already registered`)
      this.parts.set(part, read)
      return () => {
        if (this.parts.get(part) === read) this.parts.delete(part)
      }
    }, `wire.home(${part})`)
  }

  async snapshot(): Promise<JsonObject> {
    const parts = await Promise.all([...this.parts.values()].map((read) => read()))
    return Object.assign({}, ...parts)
  }

  async publishHome(): Promise<void> {
    await this.sockets?.publishHome()
  }
}
