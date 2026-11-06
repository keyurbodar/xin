import type { ConversationId, Harness } from "@earendil-works/pi-durable"
import type { Env } from "../env.ts"
import type { Provider } from "../module.ts"
import type { Actor, Command, Outcome } from "../ops.ts"
import type { Clock } from "./clock.ts"
import type { DbService } from "./db.ts"
import type { Http } from "./http.ts"
import type { XinLoader } from "./loader.ts"
import type { Manager } from "./manager.ts"
import type { Ops } from "./ops.ts"
import type { Pi } from "./pi.ts"
import type { Secrets } from "./secrets.ts"
import type { Deployer, System } from "./system.ts"
import type { Wire } from "./wire.ts"

export type Runtime = {
  readonly state: DurableObjectState
  readonly env: Env
  readonly providers: readonly Provider[]
  abort(reason: string): void
  restart(): Promise<void>
}

export type OpCall = { readonly command: Command; readonly actor: Actor }

declare module "@deepseek-ai/cordis" {
  interface Context {
    host: Runtime
    db: DbService
    pi: Pi
    harness: Harness
    ops: Ops
    http: Http
    wire: Wire
    clock: Clock
    secrets: Secrets
    plugins: Manager
    system: System
    deployer: Deployer
    kernel: XinLoader
  }

  interface Events {
    /** @mode waterfall. Policy over every op; return an Outcome without next() to decide it. */
    "ops/before"(call: OpCall, next: () => Promise<Outcome>): Promise<Outcome>
    /** @mode parallel. Typing indicator for a conversation. */
    "wire/typing"(conversation: ConversationId, on: boolean): Promise<void>
    /** @mode emit. The composed tree or a row's state changed. */
    "plugins/changed"(): void
  }
}
