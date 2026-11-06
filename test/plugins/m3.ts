import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const WIDE_MODEL = { provider: "faux-alt", modelId: "alt-wide" } as const
export const NARROW_MODEL = { provider: "faux-alt", modelId: "alt-narrow" } as const

const alt = fauxProvider({
  provider: "faux-alt",
  models: [
    { id: "alt-wide", name: "Alt Wide", contextWindow: 128_000, maxTokens: 8_192 },
    { id: "alt-narrow", name: "Alt Narrow", contextWindow: 32_768, maxTokens: 8_192 },
  ],
})

const step: FauxResponseStep = (context, _options, _state, model) => {
  const prompt = lastUserText(context.messages)
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

alt.setResponses(Array.from({ length: 64 }, () => step))

export const catalog: Catalog = {}
export const providers: readonly Provider[] = [alt.provider]

function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
  const user = messages.findLast((message) => message.role === "user")
  if (user === undefined) return ""
  if (typeof user.content === "string") return user.content
  if (!Array.isArray(user.content)) return ""
  return user.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}
