import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const DREAM_MODEL = { provider: "faux-dream", modelId: "dream-1" } as const

export const dream = fauxProvider({ provider: DREAM_MODEL.provider, models: [{ id: DREAM_MODEL.modelId }] })

export const requests: TranscriptContext[] = []

export function script(responses: readonly FauxResponseStep[]): void {
  requests.length = 0
  dream.setResponses(
    responses.map((step) => (context, options, state, model) => {
      requests.push(context)
      return typeof step === "function" ? step(context, options, state, model) : step
    }),
  )
}

export const dreamJson = (value: unknown) => fauxAssistantMessage(JSON.stringify(value))

export const catalog: Catalog = {}
export const providers: readonly Provider[] = [dream.provider]
