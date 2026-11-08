import type { Message } from "@earendil-works/pi-ai"
import type { EntryRecord } from "@earendil-works/pi-durable"

export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

export function textOf(entry: { readonly model?: readonly Message[] } | undefined): string {
  return (entry?.model ?? [])
    .flatMap((message) =>
      message.role === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
    )
    .join("")
    .trim()
}

export function entryText(entry: EntryRecord): string {
  return (entry.model ?? []).map(messageText).join("\n").trim()
}

export function excerpt(text: string, limit = 160): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function detailOf(detail: unknown): string {
  return typeof detail === "string" ? detail : JSON.stringify(detail)
}
