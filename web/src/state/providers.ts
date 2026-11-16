import { cmd } from "../lib/api.ts"
import { listOf, numOf, recordOf, strOf } from "../lib/parse.ts"
import { remote, type RemoteHandle } from "./extensions.ts"
import type { ModelRef } from "./settings.ts"

export type ProviderHealth = { readonly state: "ok" | "failing"; readonly error: string | undefined }

const parseHealth = (value: unknown): ReadonlyMap<string, ProviderHealth> =>
  new Map(
    listOf(recordOf(value)?.["providers"]).flatMap((entry): (readonly [string, ProviderHealth])[] => {
      const row = recordOf(entry)
      const id = strOf(row?.["id"])
      const health = recordOf(row?.["health"])
      const state = health?.["state"]
      if (id === undefined || (state !== "ok" && state !== "failing")) return []
      return [[id, { state, error: strOf(health?.["error"]) }]]
    }),
  )

/** Each provider's newest response outcome, from `models.catalog`; a provider with no request since the home started has none. */
export const providerHealth: RemoteHandle<ReadonlyMap<string, ProviderHealth>> = remote(
  () => cmd("models.catalog", { keyedOnly: true }),
  parseHealth,
)

export type CredentialTest = { readonly ok: true; readonly latencyMs: number } | { readonly ok: false; readonly error: string }

/** One tiny request with the stored key; the outcome also becomes the provider's health. */
export async function testCredential(provider: string): Promise<CredentialTest> {
  const result = recordOf(await cmd<unknown>("credential.test", { provider }))
  void providerHealth.reload()
  if (result?.["ok"] === true) return { ok: true, latencyMs: numOf(result["latencyMs"]) ?? 0 }
  return { ok: false, error: strOf(result?.["error"]) ?? "The test failed." }
}

export const MAX_FALLBACKS = 8

const parseRefs = (value: unknown): readonly ModelRef[] =>
  listOf(recordOf(value)?.["models"]).flatMap((entry) => {
    const ref = recordOf(entry)
    const provider = strOf(ref?.["provider"])
    const modelId = strOf(ref?.["modelId"])
    return provider === undefined || modelId === undefined ? [] : [{ provider, modelId }]
  })

/** The models a failed run moves to, in order. */
export const fallbacks: RemoteHandle<readonly ModelRef[]> = remote(() => cmd("owner.fallbacks"), parseRefs)

export async function saveFallbacks(list: readonly ModelRef[]): Promise<readonly ModelRef[]> {
  return parseRefs(await cmd("owner.fallbacks.set", { models: list.map(({ provider, modelId }) => ({ provider, modelId })) }))
}
