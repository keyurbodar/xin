import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"
import { lastOwnerText } from "../support.ts"

export const WIDE_MODEL = { provider: "faux-alt", modelId: "alt-wide" } as const
export const THINKING_MODEL = { provider: "faux-alt", modelId: "alt-think" } as const

const alt = fauxProvider({
  provider: "faux-alt",
  models: [
    { id: "alt-wide", name: "Alt Wide", contextWindow: 128_000, maxTokens: 8_192 },
    { id: "alt-narrow", name: "Alt Narrow", contextWindow: 32_768, maxTokens: 8_192 },
    { id: "alt-think", name: "Alt Think", contextWindow: 128_000, maxTokens: 8_192, reasoning: true },
  ],
})

let held: Promise<void> = Promise.resolve()

/** Holds every answer to a brief that contains "hold" until the returned release runs. */
export const hold = (): (() => void) => {
  const gate = Promise.withResolvers<void>()
  held = gate.promise
  return () => gate.resolve()
}

const step: FauxResponseStep = async (context, options, _state, model) => {
  const prompt = lastOwnerText(context.messages)
  if (prompt.includes("hold"))
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException("Request interrupted", "AbortError"))
      if (options?.signal?.aborted === true) abort()
      options?.signal?.addEventListener("abort", abort, { once: true })
      void held.then(resolve)
    })
  if (prompt.includes("structured context checkpoint summary"))
    return fauxAssistantMessage("## Goal\n- keep going\n\n## Progress\n- compacted the early turns")
  const last = context.messages.at(-1)
  const first = prompt.split("\n")[0] ?? ""
  if (last?.role !== "toolResult" && first.startsWith("switch to ")) {
    const query = first.slice("switch to ".length).trim()
    return fauxAssistantMessage([fauxToolCall("set_model", { target: "this_chat", query })], { stopReason: "toolUse" })
  }
  return fauxAssistantMessage(`answered by ${model.id}`)
}

export const resetAlt = (): void => alt.setResponses(Array.from({ length: 64 }, () => step))

resetAlt()

export const catalog: Catalog = {}
export const providers: readonly Provider[] = [alt.provider]
