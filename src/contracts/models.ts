import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import { type ConversationId, defineDoc, type ModelRef } from "@earendil-works/pi-durable"
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema"
import { obj, oneOf, str } from "@earendil-works/pi-schema"
import type { Outcome } from "../ops.ts"

export type Role = "chat" | "thread" | "utility" | "compaction"
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

export const ThinkingSchema = oneOf(MODEL_THINKING_LEVELS)

/** What a model call was for, as the usage breakdown and the per-feature caps name it. */
export const FEATURES = ["chat", "thread", "captain", "automation", "dreamer", "goal", "compaction", "other"] as const
export type Feature = (typeof FEATURES)[number]
export const FeatureSchema = oneOf(FEATURES)

/** The feature a conversation's spend is booked under, set by the plugin that created it for that feature. */
export const FeatureDoc = defineDoc<{ feature: Feature | null }>({
  kind: "xin.feature",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ feature: null }),
  checkpointWhen: () => false,
})

export const capReason = (admission: Admission & { readonly kind: "capped" }): string =>
  `the ${admission.period === "day" ? "daily" : "monthly"} ${admission.feature} cap of ${admission.cap.toFixed(2)} USD is reached; raise it in Usage first`

export type Admission =
  | { readonly kind: "ok" }
  | {
      readonly kind: "capped"
      readonly feature: Feature
      readonly period: "day" | "month"
      readonly spend: number
      readonly cap: number
    }

/** A plugin that owns conversations of one feature (Captains, automations) lists them so their spend is booked there. */
export type FeatureTracker = {
  readonly feature: Feature
  conversations(): Promise<readonly ConversationId[]>
}

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
  vision(ref: ModelRef): Promise<boolean>
  credentialSecrets(): Promise<readonly string[]>
  search(query: string): Promise<ModelSearch>
  switchModel(input: ModelSwitch): Promise<Outcome>
  /** Month-to-date spend against the owner's cap, for a surface that has to stop before it spends more. */
  spend(): Promise<{ readonly month: number; readonly cap: number | null }>
  /** Whether the owner switched `ref` off; every path that picks a model refuses one that is. */
  disabled(ref: ModelRef): Promise<boolean>
  /** Whether `feature` is under its daily and monthly caps; call it before a background model call starts. */
  admit(feature: Feature): Promise<Admission>
  /** `admit` for the feature `conversation`'s spend is booked under; call it before submitting work to it. */
  admitConversation(conversation: ConversationId): Promise<Admission>
  /** Book a model call made outside a generation into `conversation`'s `pi.usage` under `feature`. */
  charge(feature: Feature, conversation: ConversationId, message: AssistantMessage): Promise<void>
  track(tracker: FeatureTracker): () => void
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    models: ModelsService
  }
}
