import type { Context as ChordContext } from "@earendil-works/chord"
import type { ToolExecutionApi } from "@earendil-works/pi-durable"

export type AskInput = {
  readonly question: string
  readonly options?: readonly string[]
}

export type AskRecord = {
  readonly requestId: string
  readonly question: string
}

export type OpenQuestion = {
  readonly threadId: number
  readonly requestId: string
  readonly title: string
  readonly question: string
  readonly options?: readonly string[]
}

export type RespondOutcome =
  | { readonly kind: "answered"; readonly run: number }
  | { readonly kind: "already_answered"; readonly answer: string }
  | { readonly kind: "refused"; readonly message: string }

export interface QuestionsService {
  /** Open a request on the calling thread and wake its coordinator. `undefined` when the conversation is not a thread. */
  ask(api: ToolExecutionApi, context: ChordContext, input: AskInput): Promise<AskRecord | undefined>
  /** Every open request in the calling conversation's project. `undefined` outside a project. */
  open(api: ToolExecutionApi): Promise<readonly OpenQuestion[] | undefined>
  respond(api: ToolExecutionApi, threadId: number, requestId: string, answer: string): Promise<RespondOutcome>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    questions: QuestionsService
  }
}
