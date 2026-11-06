import type { Context } from "@deepseek-ai/cordis"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import type { MutableModels, Models } from "@earendil-works/pi-ai"
import type { ConversationId, Extension, Harness, JsonObject, Wake } from "@earendil-works/pi-durable"
import type { Env } from "./env.ts"
import type { Actor, Command, Op, Outcome } from "./ops.ts"

export type Provider = Parameters<MutableModels["setProvider"]>[0]

type ContextMember = keyof Context & string

type ContextServiceKeys = {
  [K in ContextMember]: Context[K] extends object
    ? Context[K] extends (...args: never[]) => unknown
      ? never
      : K
    : never
}[ContextMember]

type CordisProperty = "root" | "events" | "reflect" | "registry"

export type ServiceKey = Exclude<ContextServiceKeys, CordisProperty> & keyof Context

export type ModuleDeps<K extends ServiceKey = ServiceKey> = {
  readonly ctx: DurableObjectState
  readonly env: Env
  readonly db: SqliteDatabase
  readonly providers: readonly Provider[]
  harness(): Harness
  arm(wake?: Wake): Promise<void>
  run(command: Command, actor: Actor): Promise<Outcome>
  publishHome(): Promise<void>
  readonly services: Pick<Context, K | "get" | "inject" | "emit">
}

export type ModuleCreate<K extends ServiceKey = ServiceKey> = (deps: ModuleDeps<K>) => HostModule

export type Route = (request: Request) => Promise<Response>

export type HostModule = {
  readonly provides?: Readonly<Partial<{ [S in ServiceKey]: Context[S] }>>
  readonly extensions?: readonly Extension[]
  readonly ops?: readonly Op[]
  readonly routes?: Readonly<Record<string, Route>>
  models?(): Models
  start?(): Promise<(() => void) | void>
  due?(): Promise<number | undefined>
  fire?(now: number): Promise<void>
  typing?(conversation: ConversationId, on: boolean): Promise<void>
  home?(): Promise<JsonObject>
}
