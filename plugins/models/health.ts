import type { AssistantMessage } from "@earendil-works/pi-ai"
import { GenerationTask, hook, type HookRegistration } from "@earendil-works/pi-durable"

export type ProviderHealth = {
  readonly state: "ok" | "failing"
  readonly at: number
  readonly failures: number
  readonly error?: string
}

export type HealthBoard = {
  record(provider: string, outcome: { readonly ok: true } | { readonly ok: false; readonly error: string }): void
  get(provider: string): ProviderHealth | undefined
  readonly hook: HookRegistration
}

const MAX_ERROR = 300
const KEY_SHAPED =
  /(?<![A-Za-z0-9_-])(?:(?:sk|pk|rk|xai|gsk|ghp|hf)[-_]|AIza)[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/g

/**
 * `text` with each of `secrets` (also base64-encoded, as a Basic header carries it) and every whole word shaped like an
 * API key replaced, so a provider that echoes a key leaks nothing while model and request ids stay readable.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let clean = text
  for (const secret of secrets) {
    if (secret.length < 4) continue
    for (const form of [secret, btoa(secret)]) clean = clean.split(form).join("[redacted]")
  }
  return clean.replace(KEY_SHAPED, "[redacted]")
}

/**
 * Each provider's newest outcome, from every model response and every `credential.test`. It lives in memory, so it
 * costs no row and starts empty after an eviction; the next request on a provider fills it again.
 */
export function createHealthBoard(secrets: () => readonly string[], now: () => number = Date.now): HealthBoard {
  const board = new Map<string, ProviderHealth>()
  const record: HealthBoard["record"] = (provider, outcome) => {
    if (outcome.ok) {
      board.set(provider, { state: "ok", at: now(), failures: 0 })
      return
    }
    board.set(provider, {
      state: "failing",
      at: now(),
      failures: (board.get(provider)?.failures ?? 0) + 1,
      error: scrub(outcome.error, secrets()).slice(0, MAX_ERROR),
    })
  }
  const observe = (message: AssistantMessage): void => {
    if (message.stopReason === "aborted") return
    record(
      message.provider,
      message.stopReason === "error" ? { ok: false, error: message.errorMessage ?? "provider error" } : { ok: true },
    )
  }
  return {
    record,
    get: (provider) => board.get(provider),
    hook: hook(GenerationTask, { afterResponse: observe }),
  }
}
