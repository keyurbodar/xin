import type { AssistantMessage } from "@earendil-works/pi-ai"
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow"
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry"
import { GenerationTask, hook, type HookRegistration } from "@earendil-works/pi-durable"
import { FINAL_PROVIDER_ERROR } from "../../src/contracts/models.ts"

/**
 * Transient failures pi-ai's retry classifier does not name: a stream or body the provider or a gateway mangled, and
 * the gateway statuses it leaves out. Each one says nothing about the request itself, so the same request can succeed.
 */
const TRANSIENT = new RegExp(
  [
    "invalid.?response",
    "empty.?response",
    "malformed",
    "bad.?gateway",
    "gateway.?time.?out",
    "could not parse .*(?:sse|event|chunk|stream)",
    "invalid .*stream(?:ing)? event",
    "unexpected event type",
    "unexpected end of json",
    "unexpected token .* in json",
    "is not valid json",
    "json.?parse",
    "unterminated string in json",
    "stream completed with an unfinished tool call",
    "response has no body",
    "no response body",
    "(?<![a-z0-9])(?:408|425|522|523|529|530)(?![a-z0-9])",
  ].join("|"),
  "i",
)

/** The prefix that hands a reclassified failure to pi's durable retry; pi-ai treats this wording as transient. */
export const TRANSIENT_PREFIX = "Provider returned an error: "

/**
 * True when `message` failed with a transient fault pi-ai would otherwise treat as final. Client errors, quota, billing
 * and credit faults stay final, and so does a context overflow, which only a compaction can fix.
 */
export function needsRetry(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || message.errorMessage === undefined) return false
  if (isRetryableAssistantError(message) || isContextOverflow(message)) return false
  if (!TRANSIENT.test(message.errorMessage) || FINAL_PROVIDER_ERROR.test(message.errorMessage)) return false
  return isRetryableAssistantError({ ...message, errorMessage: `${TRANSIENT_PREFIX}${message.errorMessage}` })
}

/**
 * `afterResponse` runs on the response before the generation decides to retry it, so rewording a transient failure
 * here puts it on pi's own durable backoff (`settings.retry`) instead of ending the run on its first attempt.
 */
export const transientRetries: HookRegistration = hook(GenerationTask, {
  afterResponse: (message) => {
    if (needsRetry(message)) message.errorMessage = `${TRANSIENT_PREFIX}${message.errorMessage ?? ""}`
  },
})
