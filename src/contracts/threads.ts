import type { Context as ChordContext } from "@earendil-works/chord"
import type {
  ConversationId,
  DocumentReader,
  EntryId,
  ModelRef,
  ToolExecutionApi,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
import type { CommandId, ProjectId } from "../ids.ts"
import type { Outcome } from "../ops.ts"

export const ModelRefSchema = obj({ provider: str({ minLength: 1 }), modelId: str({ minLength: 1 }) })

export type ThreadRole = "chat" | "thread" | "utility"
export type ThreadStatus = "working" | "waiting" | "completed" | "failed" | "cancelled"
export type SendMode = "steer" | "queue"

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

export type ProjectThreads = {
  readonly project: CallerProject
  readonly threads: readonly ThreadSummary[]
}

export type LiveThread = {
  readonly id: number
  readonly title: string
  readonly status: ThreadStatus
}

export type CreateThreadArgs = {
  readonly projectId: ProjectId
  readonly parentId: ConversationId
  readonly title: string
  readonly role: ThreadRole
  readonly task: string
  readonly model: ModelRef
  readonly clientRequestId: string
  readonly requestId: string
  readonly removeTools: readonly ToolRegistration[]
}

export type CreateOutcome =
  | { readonly kind: "created"; readonly threadId: number; readonly title: string }
  | { readonly kind: "existing"; readonly threadId: number; readonly title: string }
  | { readonly kind: "limit"; readonly live: readonly LiveThread[]; readonly limit: number }
  | { readonly kind: "rejected"; readonly reason: string }

export type ResolvedThreadModel =
  | { readonly kind: "model"; readonly model: ModelRef }
  | { readonly kind: "none"; readonly reason: string }

export type EnabledPlugin = { readonly id: string; readonly state: string }

export type ThreadEntry = { readonly id: number; readonly text: string }

export interface ThreadsService {
  coordinator(read: DocumentReader, conversationId: ConversationId): Promise<CallerProject | undefined>
  threadsOf(read: DocumentReader, conversationId: ConversationId): Promise<ProjectThreads | undefined>
  threadOf(read: DocumentReader, conversationId: ConversationId, threadId: number): Promise<ThreadSummary | undefined>
  answerText(threadId: number, answer: EntryId, context: ChordContext): Promise<string>
  lastText(threadId: number, context: ChordContext): Promise<string>
  readThread(threadId: number, after: number | undefined, context: ChordContext): Promise<readonly ThreadEntry[]>
  resolveModel(
    api: ToolExecutionApi,
    role: ThreadRole,
    project: CallerProject,
    target: ModelRef | undefined,
    context: ChordContext,
  ): Promise<ResolvedThreadModel>
  createThread(tx: Tx, args: CreateThreadArgs): Promise<CreateOutcome>
  enabledPlugins(): Promise<readonly EnabledPlugin[]>
  cancelJob(conversationId: ConversationId, jobId: number): Promise<boolean>
  stopThread(
    conversationId: ConversationId,
    threadId: number,
    reason: string | undefined,
    commandId: CommandId,
  ): Promise<Outcome>
  sendToThread(
    conversationId: ConversationId,
    threadId: number,
    text: string,
    mode: SendMode,
    commandId: CommandId,
  ): Promise<Outcome>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    threads: ThreadsService
  }
}
