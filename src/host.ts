import { DurableObject } from "cloudflare:workers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, Harness, Wake } from "@earendil-works/pi-durable"
import profile from "../xin.profile.json"
import { BUNDLES, CATALOG } from "./catalog.ts"
import { XIN_VERSION } from "./catalog.gen.ts"
import type { Env } from "./env.ts"
import { HEARTBEAT_MS } from "./kernel/clock.ts"
import type { DbService } from "./kernel/db.ts"
import type { Profile } from "./kernel/layers.ts"
import { boot, type Composition, type Kernel, type XinLoader } from "./kernel/loader.ts"
import { parseProfilePatch } from "./kernel/patch.ts"
import type { Provider } from "./module.ts"
import type { Actor, Command, Outcome } from "./ops.ts"

export { HEARTBEAT_MS }

export const PROFILE: Profile = { bundles: profile.bundles, patch: parseProfilePatch(profile.patch) }

export class Home extends DurableObject<Env> {
  #kernel: Kernel | undefined
  #restarting: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(() => this.#open())
  }

  protected providers(): readonly Provider[] {
    return []
  }

  protected composition(): Composition {
    return { catalog: CATALOG, bundles: BUNDLES, profile: PROFILE, version: XIN_VERSION }
  }

  get #current(): Kernel {
    if (this.#kernel === undefined) throw new Error("Home is not open")
    return this.#kernel
  }

  get harness(): Harness {
    const harness = this.#current.root.get("harness")
    if (harness === undefined) throw new Error(`Home is not ready: ${this.#current.failure ?? "booting"}`)
    return harness
  }

  get db(): DbService {
    return this.#current.root.db
  }

  get loader(): XinLoader {
    return this.#current.loader
  }

  get commands(): { run(command: Command, actor: Actor): Promise<Outcome> } {
    return { run: (command, actor) => this.#current.root.ops.run(command, actor) }
  }

  async #open(): Promise<void> {
    const fallback = Date.now() + HEARTBEAT_MS
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback)
    this.#kernel = await boot(
      {
        state: this.ctx,
        env: this.env,
        providers: this.providers(),
        abort: (reason) => this.ctx.abort(reason),
        restart: () =>
          (this.#restarting ??= this.ctx
            .blockConcurrencyWhile(() => this.#restart())
            .finally(() => {
              this.#restarting = undefined
            })),
      },
      this.composition(),
    )
  }

  async #restart(): Promise<void> {
    const previous = this.#kernel
    this.#kernel = undefined
    await previous?.root.fiber.restart()
    await this.#open()
  }

  override async alarm(): Promise<void> {
    const { root } = this.#current
    await root.clock.arm()
    root.get("harness")?.resume()
    await root.clock.fire(Date.now())
    const harness = root.get("harness")
    await root.clock.arm(harness?.wake())
  }

  async arm(wake: Wake): Promise<void> {
    await this.#current.root.clock.arm(wake)
  }

  root(): Promise<Conversation> {
    return this.harness.root(BACKGROUND_CONTEXT)
  }

  override async fetch(request: Request): Promise<Response> {
    const { root, failure } = this.#current
    if (failure !== undefined) return Response.json({ error: "boot_failed", failure }, { status: 503 })
    const route = root.http.find(request)
    return route === undefined ? new Response("not found", { status: 404 }) : route(request)
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#current.root.wire.sockets?.message(ws, message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.#current.root.wire.sockets?.closed(ws)
  }
}
