import {
  type AssistantMessage,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const M5_MODEL = { provider: "m5", modelId: "m5-faux" } as const

const faux = fauxProvider({ provider: "m5", models: [{ id: "m5-faux", name: "M5 Faux" }] })

function hang(options: SimpleStreamOptions | undefined): Promise<AssistantMessage> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Request interrupted", "AbortError"))
    if (options?.signal?.aborted === true) abort()
    else options?.signal?.addEventListener("abort", abort, { once: true })
  })
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

function lastUserText(messages: readonly { readonly role: string; readonly content: unknown }[]): string {
  const user = messages.findLast((message) => message.role === "user")
  return user === undefined ? "" : textOf(user)
}

function delegate(index: number, clientRequestId: string, task = `do task ${index}`): AssistantMessage {
  return fauxAssistantMessage(
    [
      fauxToolCall(
        "delegate_task",
        { task, title: `Thread ${index}`, mode: "async", clientRequestId },
        { id: `delegate-${index}-${clientRequestId}` },
      ),
    ],
    { stopReason: "toolUse" },
  )
}

function sectionsText(messages: readonly { readonly role: string }[]): string {
  return messages
    .flatMap((message) => {
      if (message.role !== "system") return []
      const sections: unknown = Reflect.get(message, "sections")
      if (typeof sections !== "object" || sections === null) return []
      return Object.values(sections).filter((value): value is string => typeof value === "string")
    })
    .join("\n")
}

const step: FauxResponseStep = async (context, options) => {
  const messages = context.messages
  const system = sectionsText(messages)
  if (system.includes("You are a thread")) {
    const brief = lastUserText(messages)
    if (brief.includes("slow"))
      await new Promise((resolve) => setTimeout(resolve, brief.includes("very") ? 6_000 : 2_000))
    if (brief.includes("fail"))
      return fauxAssistantMessage("provider exploded", { stopReason: "error", errorMessage: "provider exploded" })
    if (brief.includes("think"))
      return fauxAssistantMessage([fauxThinking("soft drops kiss the earth"), fauxText(`thread answer: ${brief}`)])
    return fauxAssistantMessage(`thread answer: ${brief}`)
  }
  const prompt = lastUserText(messages)
  const results = messages.filter((message) => message.role === "toolResult")
  if (results.length > 0) {
    if (prompt.includes("delegate stop")) return hang(options)
    return fauxAssistantMessage("delegated")
  }
  if (prompt.includes("delegate 8")) {
    const calls = Array.from({ length: 8 }, (_, index) => delegate(index + 1, `eight-${index + 1}`))
    return fauxAssistantMessage(
      calls.flatMap((message) => message.content.filter((part) => part.type === "toolCall")),
      { stopReason: "toolUse" },
    )
  }
  if (prompt.includes("delegate twice")) {
    return fauxAssistantMessage(
      [delegate(1, "same"), delegate(2, "same")]
        .flatMap((message) => message.content.filter((part) => part.type === "toolCall"))
        .map((part, index) => ({ ...part, id: `twice-${index}` })),
      { stopReason: "toolUse" },
    )
  }
  if (prompt.includes("delegate limit")) {
    return fauxAssistantMessage(
      [delegate(1, "limit-1", "slow first"), delegate(2, "limit-2", "the second")]
        .flatMap((message) => message.content.filter((part) => part.type === "toolCall"))
        .map((part, index) => ({ ...part, id: `limit-${index}` })),
      { stopReason: "toolUse" },
    )
  }
  if (prompt.includes("delegate stop")) {
    const call = delegate(1, "stop-1", "slow task").content[0]
    return fauxAssistantMessage(call === undefined ? [] : [call], { stopReason: "toolUse" })
  }
  if (prompt.includes("delegate thinking")) {
    const call = delegate(1, "thinking-1", "think about it").content[0]
    return fauxAssistantMessage(call === undefined ? [] : [call], { stopReason: "toolUse" })
  }
  if (prompt.includes("delegate one")) {
    const call = delegate(1, "one-1").content[0]
    return fauxAssistantMessage(call === undefined ? [] : [call], { stopReason: "toolUse" })
  }
  return fauxAssistantMessage("noted")
}

faux.setResponses(Array.from({ length: 4_000 }, () => step))

export const providers: readonly Provider[] = [faux.provider]
export const catalog: Catalog = {}
