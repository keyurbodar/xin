import { fauxProvider, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const MCP_MODEL = { provider: "mcp-faux", modelId: "mcp-faux-1" } as const

const faux = fauxProvider({
  api: "mcp-faux",
  provider: "mcp-faux",
  models: [{ id: "mcp-faux-1" }],
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
export const catalog: Catalog = {}
