import type { Context as ChordContext } from "@earendil-works/chord"
import { defineDoc, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable"
import { arr, compile, map, num, obj, opt, str, type Static } from "@earendil-works/pi-schema"

export type AskInput = {
  readonly threadId: ConversationId
  readonly requestId: string
  readonly question: string
  readonly options?: readonly string[]
  readonly now: number
}

export type AskOutcome =
  | { readonly kind: "asked"; readonly requestId: string; readonly question: string }
  | { readonly kind: "not_a_thread" }

export type OpenQuestion = {
  readonly threadId: number
  readonly requestId: string
  readonly title: string
  readonly question: string
  readonly options?: readonly string[]
}

export type OpenOutcome =
  | { readonly kind: "open"; readonly questions: readonly OpenQuestion[] }
  | { readonly kind: "not_in_project" }

export type RespondOutcome =
  | { readonly kind: "answered"; readonly run: number }
  | { readonly kind: "already_answered"; readonly answer: string }
  | { readonly kind: "refused"; readonly message: string }

export interface QuestionsService {
  ask(input: AskInput, context: ChordContext): Promise<AskOutcome>
  open(conversationId: ConversationId): Promise<OpenOutcome>
  respond(api: ToolExecutionApi, threadId: number, requestId: string, answer: string): Promise<RespondOutcome>
}

export const RequestSchema = obj({
  kind: str({ minLength: 1 }),
  question: str(),
  options: opt(arr(str())),
  at: num(),
})
export const AnsweredSchema = obj({
  kind: str({ minLength: 1 }),
  question: str(),
  options: opt(arr(str())),
  at: num(),
  answer: str(),
  answeredAt: num(),
})
export const RequestsSchema = obj({ open: map(RequestSchema), answered: map(AnsweredSchema) })

export type OpenRequest = Static<typeof RequestSchema>
export type AnsweredRequest = Static<typeof AnsweredSchema>
export type RequestsState = Static<typeof RequestsSchema>

export const parseRequests = compile(RequestsSchema)

export const RequestsDoc = defineDoc<RequestsState>({
  kind: "xin.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ open: {}, answered: {} }),
  checkpointWhen: () => false,
})

declare module "@deepseek-ai/cordis" {
  interface Context {
    questions: QuestionsService
  }
}
