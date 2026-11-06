import { fauxProvider, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Plugin } from "../../src/plugins/host.ts"

export const SKILL_MODEL = { provider: "skills-faux", modelId: "skills-faux-1" } as const

const faux = fauxProvider({
  api: "skills-faux",
  provider: "skills-faux",
  models: [{ id: "skills-faux-1" }],
})

export const requests: TranscriptContext[] = []

export function script(responses: readonly FauxResponseStep[]): void {
  requests.length = 0
  faux.setResponses(
    responses.map((step) => (context, options, state, model) => {
      requests.push(context)
      return typeof step === "function" ? step(context, options, state, model) : step
    }),
  )
}

export const providers: readonly Provider[] = [faux.provider]
export const plugins: readonly Plugin[] = []
