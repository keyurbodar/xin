import { DurableObject } from "cloudflare:workers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare"
import { createModels, type Models } from "@earendil-works/pi-ai"
import {
  type Conversation,
  createRegistry,
  Harness,
  type JsonObject,
  type Report,
  type Wake,
} from "@earendil-works/pi-durable"
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { migrate } from "./db.ts"
import type { Env } from "./env.ts"
import * as files from "./files.ts"
import * as failures from "./failures.ts"
import * as gateway from "./gateway.ts"
import * as jobs from "./jobs.ts"
import * as mcp from "./mcp.ts"
import * as memory from "./memory.ts"
import * as push from "./push.ts"
import * as questions from "./questions.ts"
import * as schedules from "./schedules.ts"
import * as skills from "./skills.ts"
import * as watchdog from "./watchdog.ts"
import * as workspace from "./workspace.ts"
import type { PluginId } from "./ids.ts"
import type { HostModule, ModuleDeps, Provider, Route } from "./module.ts"
import * as models from "./models.ts"
import * as orchestrator from "./orchestrator.ts"
import { Commands } from "./ops.ts"
import { BUNDLED } from "./plugins/bundled.ts"
import { type Plugin, type Reconciled } from "./plugins/host.ts"
import { PluginRuntime } from "./plugins/module.ts"
import { ack, decodeCommand, Sockets } from "./wire.ts"

export const HEARTBEAT_MS = 60_000
const context = BACKGROUND_CONTEXT
const MODULES: readonly { create(deps: ModuleDeps): HostModule }[] = [
  models,
  files,
  gateway,
  memory,
  push,
  skills,
  mcp,
  workspace,
  schedules,
  orchestrator,
  jobs,
  questions,
  watchdog,
  failures,
]

type Opened = {
  readonly db: DurableObjectSqliteDatabase
  readonly harness: Harness
  readonly runtime: PluginRuntime
  readonly modules: readonly HostModule[]
  readonly commands: Commands
  readonly sockets: Sockets
}

export class Home extends DurableObject<Env> {
  #opened: Opened | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => this.#open())
  }

  protected plugins(): readonly Plugin[] {
    return BUNDLED
  }

  protected providers(): readonly Provider[] {
    return []
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
    return this.#current.runtime.reconciled
  }

  get commands(): Commands {
    return this.#current.commands
  }

  get modules(): readonly HostModule[] {
    return this.#current.modules
  }

  async #open(): Promise<void> {
    const fallback = Date.now() + HEARTBEAT_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback)
    const db = new DurableObjectSqliteDatabase(this.ctx.storage)
    await migrate(db)
    const registry = createRegistry()
    const deps: ModuleDeps = {
      ctx: this.ctx,
      env: this.env,
      db,
      providers: this.providers(),
      harness: () => this.harness,
      arm: (wake) => this.arm(wake ?? { ...this.harness.wake(), active: true }),
      run: (command, actor) => this.commands.run(command, actor),
      publishHome: () => this.#current.sockets.publishHome(),
      install: (extension) => registry.install(extension),
    }
    const modules = MODULES.map((module) => module.create(deps))
    const runtime = await PluginRuntime.open({
      db,
      kek: this.env.KEK,
      plugins: this.plugins(),
      core: modules.flatMap((module) => module.ops ?? []),
      registry,
      run: (command, actor) => this.commands.run(command, actor),
      publish: async () => {
        await this.#opened?.sockets.publishHome()
      },
    })
    for (const extension of modules.flatMap((module) => module.extensions ?? [])) registry.install(extension)
    const harness = await Harness.open(
      await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" }),
      {
        models: () => this.#models(modules),
        registry,
        env: (target) => modules.map((module) => module.env?.(target)).find((env) => env !== undefined),
        onWake: (wake) => void this.arm(wake).catch(() => this.ctx.abort("alarm write failed")),
        onReport: (report: Report) => {
          if (report.kind === "storage_failed") this.ctx.abort("storage failed")
        },
      },
      context,
    )
    const commands = new Commands(db, runtime.ops, harness)
    const sockets = new Sockets({
      ctx: this.ctx,
      harness,
      commands,
      beforeWork: () => this.arm({ ...harness.wake(), active: true }),
      typing: async (conversation, on) => {
        for (const module of modules) await module.typing?.(conversation, on)
      },
      home: () => this.home(),
    })
    this.#opened = { db, harness, runtime, modules, commands, sockets }
    for (const module of modules) await module.start?.()
    await this.arm(harness.wake())
    harness.resume()
    await sockets.rehydrate()
  }

  #models(modules: readonly HostModule[]): Models {
    const provided = modules.map((module) => module.models?.()).find((found) => found !== undefined)
    if (provided !== undefined) return provided
    const fallback = createModels()
    for (const provider of this.providers()) fallback.setProvider(provider)
    return fallback
  }

  protected async home(): Promise<JsonObject> {
    const plugins: Record<PluginId, string> = {}
    for (const [id, state] of this.reconciled.states) plugins[id] = state.kind
    const parts = await Promise.all(this.modules.map((module) => module.home?.() ?? Promise.resolve({})))
    return Object.assign({ plugins }, ...parts)
  }

  override async alarm(): Promise<void> {
    await this.arm({ ...this.harness.wake(), active: true })
    this.harness.resume()
    const now = Date.now()
    for (const module of this.modules) await module.fire?.(now)
    await this.arm(this.harness.wake())
  }

  async arm(wake: Wake): Promise<void> {
    const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined
    const owned = this.#opened === undefined ? [] : await Promise.all(this.modules.map((module) => module.due?.()))
    const due = [heartbeat, wake.at, ...owned].filter((at): at is number => at !== undefined)
    if (due.length === 0) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.min(...due))
  }

  root(): Promise<Conversation> {
    return this.harness.root(context)
  }

  #route(request: Request): Route | undefined {
    const url = new URL(request.url)
    const key = `${request.method} ${url.pathname}`
    const exact = this.modules.map((module) => module.routes?.[key]).find((route) => route !== undefined)
    if (exact !== undefined) return exact
    const prefix = this.modules
      .flatMap((module) => Object.entries(module.routes ?? {}))
      .find(([pattern]) => pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))
    return prefix?.[1]
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
    const handler = this.#route(request)
    return handler === undefined ? new Response("not found", { status: 404 }) : handler(request)
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#current.sockets.message(ws, message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.#current.sockets.closed(ws)
  }
}
