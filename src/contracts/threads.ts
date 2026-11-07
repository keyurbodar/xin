import type { Context as ChordContext, JsonValue } from "@earendil-works/chord"
import type { ConversationId, ModelRef, Tx } from "@earendil-works/pi-durable"
import { oneOf } from "@earendil-works/pi-schema"
import type { ThreadRole, ThreadStatus } from "./threaddoc.ts"

export type { ThreadRole, ThreadStatus } from "./threaddoc.ts"

export type SendMode = "steer" | "queue"
export type DelegateMode = "async" | "wait"
export type ThreadSettledStatus = Extract<ThreadStatus, "completed" | "failed" | "cancelled">

export type ThreadSettled = {
  readonly threadId: number
  readonly parentId: number
  readonly projectId: string
  readonly title: string
  readonly status: ThreadSettledStatus
  readonly result?: string
}

export const SendModeSchema = oneOf(["steer", "queue"] as const)

export type Caller = {
  readonly conversationId: ConversationId
  readonly taskId: string
}

export type CallerProject = {
  readonly projectId: string
  readonly name: string
  readonly threadLimit: number
}

export type ThreadSummary = {
  readonly id: number
  readonly title: string
  readonly status: ThreadStatus
  readonly statusLine?: string
  readonly result?: string
}

export type LiveThread = {
  readonly id: number
  readonly title: string
  readonly status: ThreadStatus
}

export type ThreadEntry = { readonly id: number; readonly text: string }

export type ReporterInput = {
  readonly threadId: number
  readonly parentId: number
  readonly title: string
  readonly run: number
  readonly brief: string
  readonly requestId: string
}

export type DelegateRequest = {
  readonly task: string
  readonly title: string
  readonly role?: ThreadRole
  readonly model?: ModelRef
  readonly mode: DelegateMode
  readonly timeoutMs?: number
  readonly clientRequestId: string
}

export type DelegateOutcome =
  | { readonly kind: "not_coordinator" }
  | { readonly kind: "no_model"; readonly reason: string }
  | { readonly kind: "limit"; readonly live: readonly LiveThread[]; readonly limit: number }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "existing"; readonly threadId: number; readonly title: string }
  | { readonly kind: "started"; readonly threadId: number; readonly title: string }
  | { readonly kind: "answered"; readonly threadId: number; readonly title: string; readonly text: string }
  | { readonly kind: "timed_out"; readonly threadId: number; readonly title: string }
  | { readonly kind: "unanswered"; readonly threadId: number; readonly title: string; readonly reason: string }
  | { readonly kind: "gone"; readonly threadId: number; readonly title: string }

export type StatusOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "thread"; readonly thread: ThreadSummary; readonly last: string }

export type StopOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "stopped"; readonly details: JsonValue }

export type SendOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "sent"; readonly note: string; readonly details: JsonValue }

export type ReadOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "entries"; readonly entries: readonly ThreadEntry[] }

export type ThreadFilter = {
  readonly projectId?: string
  readonly status?: ThreadStatus
}

export type ListOutcome =
  | { readonly kind: "not_in_project" }
  | { readonly kind: "no_project"; readonly projectId: string }
  | { readonly kind: "threads"; readonly projectId: string; readonly threads: readonly ThreadSummary[] }

export type ProjectView = {
  readonly name: string
  readonly threadLimit: number
  readonly live: number
}

export type CapabilitiesOutcome = {
  readonly model?: ModelRef
  readonly models: readonly string[]
  readonly project?: ProjectView
}

export interface ThreadsService {
  delegate(caller: Caller, request: DelegateRequest, context: ChordContext): Promise<DelegateOutcome>
  status(caller: Caller, threadId: number, context: ChordContext): Promise<StatusOutcome>
  stop(caller: Caller, threadId: number, reason: string | undefined): Promise<StopOutcome>
  send(caller: Caller, threadId: number, text: string, mode: SendMode): Promise<SendOutcome>
  read(caller: Caller, threadId: number, after: number | undefined, context: ChordContext): Promise<ReadOutcome>
  list(caller: Caller, filter: ThreadFilter): Promise<ListOutcome>
  capabilities(caller: Caller, context: ChordContext): Promise<CapabilitiesOutcome>
  report(tx: Tx, input: ReporterInput): Promise<void>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    threads: ThreadsService
  }

  interface Events {
    /**
     * @mode emit. At least once: emitted from the reporter task's idempotent report phase, after the
     * commit that records the terminal status, so a replay can emit it again and nothing fires in a
     * transaction.
     */
    "thread/settled"(event: ThreadSettled): void
  }
}
