import { DurableObject } from "cloudflare:workers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, Harness, Wake } from "@earendil-works/pi-durable"
import profile from "../xin.profile.json"
import { BUNDLES, CATALOG } from "./catalog.ts"
import { XIN_VERSION } from "./catalog.gen.ts"
import type { Env } from "./env.ts"
import { messageOf } from "./errors.ts"
import { HEARTBEAT_MS } from "./kernel/clock.ts"
import type { DbService } from "./kernel/db.ts"
import type { Profile } from "./kernel/layers.ts"
import { boot, type Composition, type Kernel, type XinLoader } from "./kernel/loader.ts"
import { parseProfilePatch } from "./kernel/patch.ts"
import type { Provider } from "./module.ts"
import type { Actor, Command, Outcome } from "./ops.ts"

export { HEARTBEAT_MS }

export const PROFILE: Profile = { bundles: profile.bundles, patch: parseProfilePatch(profile.patch) }

/** The one route a home that cannot boot still answers; it is handled without the kernel. */
const REPAIR = "/v1/repair"

export class Home extends DurableObject<Env> {
  #kernel: Kernel | undefined
  /** Why the home cannot serve, from the kernel or from a boot that threw: a home that cannot boot answers only repair. */
  #failure: string | undefined
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
    try {
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
      this.#failure = this.#kernel.failure
    } catch (error) {
      // A home whose journal or checkpoint cannot be read must stay answerable, so its repair route can drop them.
      this.#kernel = undefined
      this.#failure = messageOf(error)
    }
  }

  async #restart(): Promise<void> {
    const previous = this.#kernel
    this.#kernel = undefined
    await previous?.root.fiber.restart()
    await this.#open()
  }

  override async alarm(): Promise<void> {
    if (this.#kernel === undefined) return
    const { root } = this.#kernel
    root.clock.fired()
    try {
      await root.clock.arm()
      root.get("harness")?.resume()
      await root.clock.fire(Date.now())
    } finally {
      // The closing arm always runs: an alarm that throws before it would leave the home asleep until the next event.
      const harness = root.get("harness")
      await root.clock.arm(harness?.wake())
    }
  }

  async arm(wake: Wake): Promise<void> {
    await this.#current.root.clock.arm(wake)
  }

  root(): Promise<Conversation> {
    return this.harness.root(BACKGROUND_CONTEXT)
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === REPAIR) return this.#repair(request)
    if (this.#failure !== undefined)
      return Response.json({ error: "boot_failed", failure: this.#failure }, { status: 503 })
    const { root } = this.#current
    const route = root.http.find(request)
    return route === undefined ? new Response("not found", { status: 404 }) : route(request)
  }

  /**
   * Boot's escape hatch. A home whose journal or checkpoint cannot be read answers nothing else, so this drops the
   * journal rows (`journal`, the state since the last checkpoint) or the checkpoint too (`all`) and opens again.
   * Without a body it only reports what is there, and it refuses to touch a home that is open.
   */
  async #repair(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => undefined)
    const requested = typeof body === "object" && body !== null ? Reflect.get(body, "drop") : undefined
    const drop = requested === "journal" || requested === "all" ? requested : undefined
    if (requested !== undefined && drop === undefined)
      return Response.json({ error: "bad_args", message: "drop is journal or all" }, { status: 400 })
    if (drop !== undefined) {
      if (this.#failure === undefined)
        return Response.json({ error: "busy", message: "the home is open" }, { status: 409 })
      const sql = this.ctx.storage.sql
      if (drop === "all") {
        sql.exec("DELETE FROM pi_checkpoint_part").toArray()
        sql.exec("DELETE FROM pi_checkpoint").toArray()
      }
      sql.exec("DELETE FROM pi_journal").toArray()
      // A kernel whose required row failed is discarded: the next boot opens the storage the drop left behind.
      this.#kernel = undefined
      await this.#open()
    }
    return Response.json({
      failure: this.#failure ?? null,
      journal: this.#count("pi_journal"),
      checkpoint: this.#count("pi_checkpoint"),
    })
  }

  /** A repair route must answer even when its tables were never created, so a missing one counts as zero. */
  #count(table: "pi_journal" | "pi_checkpoint"): number {
    try {
      return this.ctx.storage.sql.exec<{ rows: number }>(`SELECT COUNT(*) AS rows FROM ${table}`).one().rows
    } catch {
      return 0
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#current.root.wire.sockets?.message(ws, message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.#current.root.wire.sockets?.closed(ws)
  }
}
