import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable"
import { obj, oneOf, str } from "@earendil-works/pi-schema"
import type { Outcome } from "../ops.ts"

export type Role = "chat" | "thread" | "utility"
export type ModelDefaults = { readonly [K in Role]?: ModelRef }
export type ResolvedModel =
  | { readonly kind: "model"; readonly model: ModelRef; readonly source: "conversation" | "project" | "owner" }
  | { readonly kind: "none" }

export function resolveModel(input: {
  readonly role: Role
  readonly conversation?: ModelRef
  readonly project?: ModelDefaults
  readonly owner?: ModelDefaults
}): ResolvedModel {
  if (input.conversation !== undefined) return { kind: "model", model: input.conversation, source: "conversation" }
  const project = input.project?.[input.role]
  if (project !== undefined) return { kind: "model", model: project, source: "project" }
  const owner = input.owner?.[input.role]
  if (owner !== undefined) return { kind: "model", model: owner, source: "owner" }
  return { kind: "none" }
}

export const ModelRefSchema = obj({ provider: str({ minLength: 1 }), modelId: str({ minLength: 1 }) })

export const ThinkingSchema = oneOf(["off", "low", "medium", "high"] as const)

export type ModelMatch = {
  readonly model: Model<Api>
  readonly score: number
}

export type ModelSearch = {
  readonly catalog: readonly Model<Api>[]
  readonly matches: readonly ModelMatch[]
}

export type ModelSwitch = {
  readonly conversation: ConversationId
  readonly caller: ConversationId
  readonly model: ModelRef
  readonly thinking?: ModelThinkingLevel
  readonly callId: string
}

export interface ModelsService {
  ownerDefaults(): Promise<ModelDefaults>
  credentialSecrets(): Promise<readonly string[]>
  search(query: string): Promise<ModelSearch>
  switchModel(input: ModelSwitch): Promise<Outcome>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    models: ModelsService
  }
}
