import { GenerationTask, hook, type HookRegistration } from "@earendil-works/pi-durable"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"

/** The cache directives pi-ai writes with a one-hour `ttl`: Anthropic-format `cache_control` and Bedrock `cachePoint`. */
const DIRECTIVES = ["cache_control", "cachePoint"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A shallow copy of one block whose cache directive no longer names a `ttl`; any other block is returned as is. */
function shortBlock(block: unknown): unknown {
  if (!isRecord(block)) return block
  let copy: Record<string, unknown> | undefined
  for (const key of DIRECTIVES) {
    const directive = block[key]
    if (!isRecord(directive) || !("ttl" in directive)) continue
    copy ??= { ...block }
    copy[key] = Object.fromEntries(Object.entries(directive).filter(([field]) => field !== "ttl"))
  }
  return copy ?? block
}

const shortBlocks = (value: unknown): unknown => (Array.isArray(value) ? value.map(shortBlock) : value)

function shortMessage(message: unknown): unknown {
  const shortened = shortBlock(message)
  if (!isRecord(shortened) || !Array.isArray(shortened.content)) return shortened
  return { ...shortened, content: shortBlocks(shortened.content) }
}

/**
 * A request body with every cache breakpoint at the provider's default five-minute TTL.
 *
 * The harness asks for long retention, which is right for a coordinator whose messages arrive minutes apart. A thread
 * runs tight tool rounds, so the one-hour write it would pay (2x input instead of 1.25x) never earns its keep. Only the
 * places pi-ai puts a breakpoint are touched — system blocks, tool declarations, messages and their content blocks — so
 * tool arguments, schemas and binary content pass through unchanged, and only the Anthropic and Bedrock directive shapes
 * carry a premium for the longer TTL.
 */
export function withShortCache(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const copy: Record<string, unknown> = { ...payload }
  if ("system" in payload) copy.system = shortBlocks(payload.system)
  if ("tools" in payload) copy.tools = shortBlocks(payload.tools)
  if (Array.isArray(payload.messages)) copy.messages = payload.messages.map(shortMessage)
  return copy
}

export const threadCache: HookRegistration = hook(GenerationTask, {
  beforeProviderRequest: async (request, api, context) => {
    const thread = await api.snapshot(ThreadDoc, api.conversationId, context)
    return thread === undefined ? undefined : { payload: withShortCache(request.payload) }
  },
})
