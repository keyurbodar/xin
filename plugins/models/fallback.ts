import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow"
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry"
import {
  AgentDoc,
  type ConversationId,
  GenerationTask,
  hook,
  type HookRegistration,
  LiveDoc,
  type ModelRef,
} from "@earendil-works/pi-durable"
import { needsRetry, TRANSIENT_PREFIX } from "./resilience.ts"

const context = BACKGROUND_CONTEXT
export const FALLBACK_KIND = "xin.fallback"

/** Faults of the provider account behind the key, which another provider's key does not share. */
const ACCOUNT_FAULT =
  /(?:^\s*|(?:http|status|code)\D{0,3})(?:401|402|403|404)\b|insufficient_quota|quota exceeded|out of budget|billing|credit.?balance|usage.?limit/i

/**
 * Whether a failed response should move to a fallback model now. A transient fault does so only on the last attempt
 * pi would retry, so the provider's own retries come first; a fault of the provider account does so at once. A request
 * fault (a bad body, a 400) and a context overflow never do: every model would refuse them too.
 */
export function wantsFallback(message: AssistantMessage, attempt: number, maxRetries: number): boolean {
  if (message.stopReason !== "error" || message.errorMessage === undefined) return false
  if (attempt > maxRetries || isContextOverflow(message)) return false
  if (isRetryableAssistantError(message) || needsRetry(message)) return attempt === maxRetries
  return ACCOUNT_FAULT.test(message.errorMessage)
}

export type FallbackPorts = {
  readonly maxRetries: number
  /** The owner's fallback order, held in memory. */
  order(): readonly ModelRef[]
  /** The model when a stored key unlocks it and the owner has not switched it off. */
  usable(ref: ModelRef): Promise<Model<Api> | undefined>
  /** The model as the catalog knows it, keyed or not. */
  known(ref: ModelRef): Model<Api> | undefined
  /** Whether the conversation's feature is under its caps. */
  admitted(conversation: ConversationId): Promise<boolean>
  /** Switch the conversation's model the way `conv.configure` does; true when it was switched. */
  configure(conversation: ConversationId, model: ModelRef, commandId: string): Promise<boolean>
  /** Leave a `xin.fallback` entry in the conversation. */
  note(
    conversation: ConversationId,
    requestId: string,
    data: { from: ModelRef; to: ModelRef; error: string },
  ): Promise<void>
}

const same = (left: ModelRef, right: ModelRef): boolean =>
  left.provider === right.provider && left.modelId === right.modelId

/**
 * Within the failing run: switch the conversation to the next fallback after its current model in the owner's order
 * that is keyed, enabled, at least as large in context and as able to see images, then hand the failure to pi's own
 * retry, so the next attempt of the same generation runs on that model. The run never fails, so no failure is reported
 * and nothing resumes it twice. Walking forward through the order ends every chain, and pi's attempt budget bounds it.
 */
export function fallbackHook(ports: FallbackPorts): HookRegistration {
  return hook(GenerationTask, {
    afterResponse: async (message, api) => {
      if (message.stopReason !== "error" || ports.order().length === 0) return
      const conversationId = api.conversationId
      const attempt = (await api.snapshot(LiveDoc, conversationId, context))?.generation?.attempt ?? 1
      if (!wantsFallback(message, attempt, ports.maxRetries)) return
      const from = (await api.snapshot(AgentDoc, conversationId, context))?.model
      if (from === undefined) return
      const current = ports.known(from)
      const order = ports.order()
      const start = order.findIndex((ref) => same(ref, from)) + 1
      let to: ModelRef | undefined
      for (const candidate of order.slice(start)) {
        if (same(candidate, from)) continue
        const model = await ports.usable(candidate)
        if (model === undefined) continue
        if (current !== undefined && model.contextWindow < current.contextWindow) continue
        if (current?.input.includes("image") === true && !model.input.includes("image")) continue
        to = candidate
        break
      }
      if (to === undefined || !(await ports.admitted(conversationId))) return
      const id = `fallback:${conversationId}:${api.taskId}:${attempt}`
      if (!(await ports.configure(conversationId, to, id))) return
      const error = message.errorMessage ?? ""
      await ports.note(conversationId, id, { from, to, error: error.slice(0, 300) })
      message.errorMessage = `${TRANSIENT_PREFIX}switched from ${from.provider}/${from.modelId} to ${to.provider}/${to.modelId}`
    },
  })
}
