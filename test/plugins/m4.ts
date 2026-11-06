import {
  type FauxResponseStep,
  type Message,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"

export const M4_MODEL = { provider: "m4", modelId: "m4-faux" } as const

function lastUserText(messages: readonly Message[]): string {
  const user = messages.findLast((message) => message.role === "user")
  if (user === undefined) return ""
  if (typeof user.content === "string") return user.content
  if (!Array.isArray(user.content)) return ""
  return user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

function toolText(message: Message): string {
  return message.role === "toolResult"
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : ""
}

const step: FauxResponseStep = (context) => {
  const match = /^m4 write (\S+)\n([\s\S]*)$/.exec(lastUserText(context.messages))
  const path = match?.[1]
  const content = match?.[2]
  if (path === undefined || content === undefined) return fauxAssistantMessage("unscripted")
  const results = context.messages.filter((message) => message.role === "toolResult")
  if (results.length === 0)
    return fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" })
  if (results.length === 1) return fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" })
  const last = results.at(-1)
  return fauxAssistantMessage(`read back: ${last === undefined ? "" : toolText(last)}`)
}

const faux = fauxProvider({ provider: "m4", models: [{ id: "m4-faux" }] })
faux.setResponses(Array.from({ length: 2000 }, () => step))

export const providers: readonly Provider[] = [faux.provider]
export const catalog: Catalog = {}
