import { createModels } from "@earendil-works/pi-ai"
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go"

export const LIVE_PROVIDER = "opencode-go"

export type LiveModel = {
  readonly provider: typeof LIVE_PROVIDER
  readonly modelId: string
}

export const liveEnabled = (): boolean => process.env.XIN_LIVE === "1"

export function liveModels(): readonly string[] {
  return (process.env.XIN_LIVE_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

export async function answeringModels(ids: readonly string[]): Promise<readonly LiveModel[]> {
  const models = createModels()
  models.setProvider(opencodeGoProvider())
  const answering: LiveModel[] = []
  const failures: string[] = []
  for (const modelId of ids) {
    const model = models.getModel(LIVE_PROVIDER, modelId)
    if (model === undefined) {
      failures.push(`${modelId}: not in the pi-ai catalog`)
      continue
    }
    try {
      const reply = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { maxTokens: 1, sessionId: crypto.randomUUID() },
      )
      if (reply.stopReason === "error") failures.push(`${modelId}: ${reply.errorMessage ?? "request failed"}`)
      else answering.push({ provider: LIVE_PROVIDER, modelId })
    } catch (error) {
      failures.push(`${modelId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (answering.length === 0) throw new Error(`no XIN_LIVE_MODELS answered a probe: ${failures.join("; ")}`)
  return answering
}
