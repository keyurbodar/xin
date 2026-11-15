import { GenerationTask, hook, type HookRegistration } from "@earendil-works/pi-durable"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"

/**
 * A copy of an Anthropic-format request body with every cache breakpoint at the provider's default five-minute TTL.
 *
 * The harness asks for long retention, which is right for a coordinator whose messages arrive minutes apart. A thread
 * runs tight tool rounds, so the one-hour write it would pay (2x input instead of 1.25x) never earns its keep. Only an
 * Anthropic-format `cache_control` carries a write premium for the longer TTL, so that is the only shape changed.
 */
export function withShortCache(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(withShortCache)
  if (typeof payload !== "object" || payload === null) return payload
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === "cache_control" && typeof value === "object" && value !== null && "ttl" in value) {
      copy[key] = Object.fromEntries(Object.entries(value).filter(([field]) => field !== "ttl"))
    } else {
      copy[key] = withShortCache(value)
    }
  }
  return copy
}

export const threadCache: HookRegistration = hook(GenerationTask, {
  beforeProviderRequest: async (request, api, context) => {
    const thread = await api.snapshot(ThreadDoc, api.conversationId, context)
    return thread === undefined ? undefined : { payload: withShortCache(request.payload) }
  },
})
