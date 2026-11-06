import type { JsonRepresentation } from "@earendil-works/chord"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { LiveState } from "@earendil-works/pi-durable"

export type InboundKind = "user" | "report" | "question" | "job"

export type Batch = {
  readonly kinds: readonly InboundKind[]
  readonly texts: readonly string[]
}

export type LiveProbe = {
  readonly busy: boolean
  readonly visibleChars: number
  readonly toolCalls: number
  readonly answered: boolean
}

export type DispatchMode =
  | { readonly kind: "start" }
  | { readonly kind: "steer" }
  | { readonly kind: "restart" }
  | { readonly kind: "stop" }

const STOP_WORDS: ReadonlySet<string> = new Set(["stop", "wait", "cancel", "nvm"])

export function probe(live: LiveState | undefined): LiveProbe {
  const run = live?.run
  if (run === undefined) return { busy: false, visibleChars: 0, toolCalls: 0, answered: false }
  return {
    busy: true,
    visibleChars: textChars(live?.generation?.message),
    toolCalls: live?.tools?.length ?? 0,
    answered: run.afterRun !== undefined,
  }
}

export function decide(live: LiveProbe, batch: Batch): DispatchMode {
  if (!live.busy) return { kind: "start" }
  if (stopWordsOnly(batch)) return { kind: "stop" }
  if (live.answered || live.visibleChars > 0 || live.toolCalls > 0) return { kind: "steer" }
  if (!batch.kinds.every((kind) => kind === "user")) return { kind: "steer" }
  return { kind: "restart" }
}

export function stopWordsOnly(batch: Batch): boolean {
  return (
    batch.kinds.length > 0 &&
    batch.kinds.every((kind) => kind === "user") &&
    batch.texts.length > 0 &&
    batch.texts.every((text) => STOP_WORDS.has(text.trim().toLowerCase()))
  )
}

function textChars(message: JsonRepresentation<AssistantMessage> | undefined): number {
  if (message === undefined) return 0
  return message.content.reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0)
}
