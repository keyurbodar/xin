import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import type { PluginId } from "../../src/ids.ts"
import type { Provider } from "../../src/module.ts"
import { definePlugin, type Plugin } from "../../src/plugins/host.ts"

const NONE = { net: [], memory: "none", files: "none" } as const

const faux = fauxProvider({ provider: "m2", models: [{ id: "m2-hold", name: "M2 Hold" }] })

export const M2_MODEL = { provider: "m2", modelId: "m2-hold" } as const

export const providers: readonly Provider[] = [faux.provider]

export function script(responses: readonly FauxResponseStep[]): void {
  faux.setResponses([...responses])
}

const hold = defineTool({
  name: "hold",
  description: "Block until the run is aborted.",
  parameters: obj({}),
  replay: "safe",
  execute: () => new Promise<never>(() => undefined),
})

export const plugins: readonly Plugin[] = [
  definePlugin(
    { id: "m2" as PluginId, version: "0.0.0", requires: [], provides: ["tool:hold"], permissions: NONE },
    () => ({ extensions: [defineExtension({ name: "m2.hold", tools: [hold] })] }),
  ),
]
