import type { Api, Model } from "@earendil-works/pi-ai"
import { defineDoc, GenerationTask, hook, type HookRegistration, type ModelRef } from "@earendil-works/pi-durable"

export type Mode = "fast"

/**
 * The model a conversation turned Fast mode on for. It applies only while the conversation runs that model, so a
 * switch by any path (a disable, `captain.update`, pi's own configure) leaves it inert.
 */
export const FastDoc = defineDoc<{ model: ModelRef | null }>({
  kind: "xin.fast",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ model: null }),
  checkpointWhen: () => false,
})

export const fastOn = (doc: { readonly model: ModelRef | null } | undefined, model: ModelRef | undefined): boolean =>
  doc?.model != null &&
  model !== undefined &&
  doc.model.provider === model.provider &&
  doc.model.modelId === model.modelId

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
    const doc = await api.snapshot(FastDoc, api.conversationId, context)
    if (!fastOn(doc, { provider: request.model.provider, modelId: request.model.id })) return undefined
    const payload = fastPayload(request.model, request.payload)
    return payload === undefined ? undefined : { payload }
  },
})
