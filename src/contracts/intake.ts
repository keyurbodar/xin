import type { ConversationId } from "@earendil-works/pi-durable"

export type InboundKind = "user" | "report" | "question" | "job"

export type InboundContent =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "report" | "question" | "job"
      readonly threadId: string
      readonly title: string
      readonly status: string
      readonly text: string
    }

export type InboundDraft = {
  readonly target: ConversationId
  readonly commandId: string
  readonly clientTs?: number
} & InboundContent

export type InboundBody = {
  readonly text: string
  readonly threadId: string
  readonly title: string
  readonly status: string
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "string" ? found : undefined
}

export function parseInboundBody(body: string): InboundBody {
  const value: unknown = JSON.parse(body)
  return {
    text: stringField(value, "text") ?? body,
    threadId: stringField(value, "threadId") ?? "",
    title: stringField(value, "title") ?? "",
    status: stringField(value, "status") ?? "",
  }
}

export type InboundRecord = {
  readonly id: number
  readonly target: ConversationId
  readonly kind: InboundKind
  readonly commandId: string
  readonly content: InboundContent
  readonly clientTs: number
}

export interface IntakeService {
  enqueue(draft: InboundDraft): Promise<boolean>
  withdraw(commandId: string): Promise<boolean>
  batch(batchId: string): Promise<readonly InboundRecord[]>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    intake: IntakeService
  }
}
