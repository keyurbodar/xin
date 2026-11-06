import { DurableObject } from "cloudflare:workers"
import type { JsonObject } from "@earendil-works/pi-durable"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare"
import { createModels, type Models } from "@earendil-works/pi-ai"
import { type Conversation, createRegistry, Harness, type Report, type Wake } from "@earendil-works/pi-durable"
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { migrate } from "./db.ts"
import type { Env } from "./env.ts"
import type { PluginId } from "./ids.ts"
import { Commands } from "./ops.ts"
import { BUNDLED } from "./plugins/bundled.ts"
import { type Plugin, type Reconciled, reconcile, stateError } from "./plugins/host.ts"
import { ack, decodeCommand, Sockets } from "./wire.ts"

export const HEARTBEAT_MS = 60_000
const context = BACKGROUND_CONTEXT

type Opened = {
  readonly db: DurableObjectSqliteDatabase
  readonly harness: Harness
  readonly plugins: Reconciled
  readonly commands: Commands
  readonly sockets: Sockets
}

export class Home extends DurableObject<Env> {
  #opened: Opened | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => this.#open())
  }

  protected models(): Models {
    return createModels()
  }

  protected plugins(): readonly Plugin[] {
    return BUNDLED
  }

  get #current(): Opened {
    if (this.#opened === undefined) throw new Error("Home is not open")
    return this.#opened
  }

  get harness(): Harness {
    return this.#current.harness
  }

  get db(): DurableObjectSqliteDatabase {
    return this.#current.db
  }

  get reconciled(): Reconciled {
    return this.#current.plugins
  }

  get commands(): Commands {
    return this.#current.commands
  }

  async #open(): Promise<void> {
    const fallback = Date.now() + HEARTBEAT_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback)
    const db = new DurableObjectSqliteDatabase(this.ctx.storage)
    await migrate(db)
    const disabled = new Set(
      (await db.all<{ id: string }>("SELECT id FROM plugins WHERE enabled = 0")).map((r) => r.id),
    )
    const plugins = reconcile(this.plugins(), (id) => !disabled.has(id))
    for (const [id, state] of plugins.states)
      await db.run(
        "INSERT INTO plugins (id, state, error) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, error = excluded.error",
        id,
        state.kind,
        stateError(state) ?? null,
      )
    const registry = createRegistry()
    for (const extension of plugins.extensions) registry.install(extension)
    const harness = await Harness.open(
      await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" }),
      {
        models: this.models(),
        registry,
        onWake: (wake) => void this.arm(wake).catch(() => this.ctx.abort("alarm write failed")),
        onReport: (report: Report) => {
          if (report.kind === "storage_failed") this.ctx.abort("storage failed")
        },
      },
      context,
    )
    const commands = new Commands(db, plugins.ops, harness)
    const sockets = new Sockets({
      ctx: this.ctx,
      harness,
      commands,
      beforeWork: () => this.arm({ ...harness.wake(), active: true }),
      home: () => this.home(),
    })
    this.#opened = { db, harness, plugins, commands, sockets }
    await this.arm(harness.wake())
    harness.resume()
    await sockets.rehydrate()
  }

  protected async home(): Promise<JsonObject> {
    const plugins: Record<PluginId, string> = {}
    for (const [id, state] of this.reconciled.states) plugins[id] = state.kind
    return { plugins }
  }

  override async alarm(): Promise<void> {
    await this.arm({ ...this.harness.wake(), active: true })
    this.harness.resume()
  }

  async arm(wake: Wake): Promise<void> {
    const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined
    const due = [heartbeat, wake.at].filter((at): at is number => at !== undefined)
    if (due.length === 0) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.min(...due))
  }

  root(): Promise<Conversation> {
    return this.harness.root(context)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    if (route === "GET /v1/socket" && request.headers.get("upgrade") === "websocket")
      return this.#current.sockets.accept(request.headers.get("x-xin-protocol") ?? undefined)
    if (route === "GET /v1/status") return Response.json({ wake: this.harness.wake() })
    if (route === "POST /v1/cmd") {
      const command = decodeCommand(await request.json().catch(() => undefined))
      if (command === undefined) return Response.json({ error: "bad command frame" }, { status: 400 })
      await this.arm({ ...this.harness.wake(), active: true })
      return Response.json(ack(command.id, await this.commands.run(command, { kind: "owner" })))
    }
    return new Response("not found", { status: 404 })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#current.sockets.message(ws, message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.#current.sockets.closed(ws)
  }
}
