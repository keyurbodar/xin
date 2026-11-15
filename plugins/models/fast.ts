import type { Api, Model } from "@earendil-works/pi-ai"
import { defineDoc, GenerationTask, hook, type HookRegistration } from "@earendil-works/pi-durable"

export type Mode = "fast"

/** A conversation's Fast mode; it applies only while the conversation's model lists `fast`. */
export const FastDoc = defineDoc<{ on: boolean }>({
  kind: "xin.fast",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ on: false }),
  checkpointWhen: () => false,
})

/**
 * The faster tiers pi-ai can both send and price: OpenAI's priority `service_tier` on its own Responses endpoint, which
 * pi-ai bills at the tier the response reports. Gateways and other providers on the same API have no such tier.
 */
export const modesOf = (model: Pick<Model<Api>, "api" | "provider">): Mode[] =>
  model.api === "openai-responses" && model.provider === "openai" ? ["fast"] : []

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The request body with OpenAI's priority tier, or undefined when the model has no fast mode. */
export function fastPayload(model: Pick<Model<Api>, "api" | "provider">, payload: unknown): unknown {
  return modesOf(model).includes("fast") && isRecord(payload) ? { ...payload, service_tier: "priority" } : undefined
}

export const fastRequests: HookRegistration = hook(GenerationTask, {
  beforeProviderRequest: async (request, api, context) => {
    if ((await api.snapshot(FastDoc, api.conversationId, context))?.on !== true) return undefined
    const payload = fastPayload(request.model, request.payload)
    return payload === undefined ? undefined : { payload }
  },
})
