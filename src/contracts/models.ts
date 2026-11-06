import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable"
import { oneOf } from "@earendil-works/pi-schema"
import type { Outcome } from "../ops.ts"

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
  search(query: string): Promise<ModelSearch>
  switchModel(input: ModelSwitch): Promise<Outcome>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    models: ModelsService
  }
}
