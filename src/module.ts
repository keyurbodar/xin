import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import type { MutableModels, Models } from "@earendil-works/pi-ai"
import type { ConversationId, EnvTarget, Extension, Harness, JsonObject, Wake } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { Env } from "./env.ts"
import type { Actor, Command, Op, Outcome } from "./ops.ts"

export type Provider = Parameters<MutableModels["setProvider"]>[0]

export type ModuleDeps = {
  readonly ctx: DurableObjectState
  readonly env: Env
  readonly db: SqliteDatabase
  readonly providers: readonly Provider[]
  harness(): Harness
  arm(wake?: Wake): Promise<void>
  run(command: Command, actor: Actor): Promise<Outcome>
  publishHome(): Promise<void>
  install(extension: Extension): () => void
}

export type Route = (request: Request) => Promise<Response>

export type HostModule = {
  readonly provides?: Readonly<Record<string, object>>
  readonly extensions?: readonly Extension[]
  readonly ops?: readonly Op[]
  readonly routes?: Readonly<Record<string, Route>>
  models?(): Models
  env?(target: EnvTarget): ExecutionEnv | undefined
  start?(): Promise<(() => void) | void>
  due?(): Promise<number | undefined>
  fire?(now: number): Promise<void>
  typing?(conversation: ConversationId, on: boolean): Promise<void>
  home?(): Promise<JsonObject>
}
