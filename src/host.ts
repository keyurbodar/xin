import { DurableObject } from "cloudflare:workers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare"
import { createModels, type Models } from "@earendil-works/pi-ai"
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  type Report,
  type Wake,
} from "@earendil-works/pi-durable"
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { migrate } from "./db.ts"
import type { Env } from "./env.ts"

export const HEARTBEAT_MS = 60_000
const context = BACKGROUND_CONTEXT

export class Home extends DurableObject<Env> {
  #opened: { readonly db: DurableObjectSqliteDatabase; readonly harness: Harness } | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => this.#open())
  }

  protected models(): Models {
    return createModels()
  }

  protected extensions(): readonly Extension[] {
    return []
  }

  get #current(): { readonly db: DurableObjectSqliteDatabase; readonly harness: Harness } {
    if (this.#opened === undefined) throw new Error("Home is not open")
    return this.#opened
  }

  get harness(): Harness {
    return this.#current.harness
  }

  get db(): DurableObjectSqliteDatabase {
    return this.#current.db
  }

  async #open(): Promise<void> {
    const fallback = Date.now() + HEARTBEAT_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback)
    const db = new DurableObjectSqliteDatabase(this.ctx.storage)
    await migrate(db)
    const registry = createRegistry()
    for (const extension of this.extensions()) registry.install(extension)
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
    this.#opened = { db, harness }
    await this.arm(harness.wake())
    harness.resume()
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

  async submit(text: string, requestId: string): Promise<void> {
    await this.arm({ ...this.harness.wake(), active: true })
    await (await this.root()).submit({ type: "input", content: text, requestId }, context)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/v1/status") return Response.json({ wake: this.harness.wake() })
    return new Response("not found", { status: 404 })
  }
}
