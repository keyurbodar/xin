import type { ConversationId } from "@earendil-works/pi-durable"
import type { BatchId } from "../ids.ts"
import type { MessageAttachment } from "./message.ts"

export type InboundKind = "user" | "report" | "question" | "job"

export type InboundContent =
  | { readonly kind: "user"; readonly text: string; readonly attachments: readonly MessageAttachment[] }
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
  readonly attachments: readonly MessageAttachment[]
  readonly threadId: string
  readonly title: string
  readonly status: string
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "string" ? found : undefined
}

function objectField(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== "object" || value === null) return []
  const found: unknown = Reflect.get(value, key)
  return Array.isArray(found) ? found : []
}

function attachmentOf(value: unknown): MessageAttachment | undefined {
  const path = stringField(value, "path")
  const name = stringField(value, "name")
  const type = stringField(value, "type")
  if (path === undefined || name === undefined || type === undefined) return undefined
  const size: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "size") : undefined
  return { path, name, type, ...(typeof size === "number" ? { size } : {}) }
}

export function parseInboundBody(body: string): InboundBody {
  const value: unknown = JSON.parse(body)
  return {
    text: stringField(value, "text") ?? body,
    attachments: objectField(value, "attachments").flatMap((entry) => {
      const attachment = attachmentOf(entry)
      return attachment === undefined ? [] : [attachment]
    }),
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

export type IntakeBatchRow =
  | {
      readonly id: number
      readonly kind: "user"
      readonly clientTs: number
      readonly commandId: string
      text: string
      readonly attachments: readonly MessageAttachment[]
      /** The body stored for this row, so a dispatch that rewrites nothing stores nothing. */
      readonly stored?: string
    }
  | {
      readonly id: number
      readonly kind: "report" | "question" | "job"
      readonly clientTs: number
      readonly commandId: string
      readonly threadId: string
      readonly title: string
      readonly status: string
      text: string
      readonly stored?: string
    }

export type IntakeBatch = {
  readonly batchId: BatchId
  readonly target: ConversationId
  rows: readonly IntakeBatchRow[]
}

export type IntakeBatchResult = { readonly kind: "dispatched" } | { readonly kind: "dropped"; readonly reason: string }

declare module "@deepseek-ai/cordis" {
  interface Context {
    intake: IntakeService
  }

  interface Events {
    /**
     * @mode waterfall. A claimed batch is about to be dispatched. Listeners run at the first
     * fire after every row has mounted, so a batch claimed before a crash reaches the listeners
     * enabled for the new boot. A listener edits `rows` (or a row's `text`) in place and calls
     * `next()`; `next()` stores the rewritten rows before it submits them. Return
     * `{ kind: "dropped", reason }` without calling `next()` to mark the batch done unsent.
     * A listener that throws is logged and skipped, and the batch dispatches as given. A replay
     * after a crash submits the stored rows without running this event again.
     */
    "intake/batch"(batch: IntakeBatch, next: () => Promise<IntakeBatchResult>): Promise<IntakeBatchResult>
  }
}
