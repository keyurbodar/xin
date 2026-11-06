import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"
import { testPlugin } from "../kernel.ts"

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

export const catalog: Catalog = {
  m2: testPlugin("m2", { extensions: [defineExtension({ name: "m2.hold", tools: [hold] })] }),
}
