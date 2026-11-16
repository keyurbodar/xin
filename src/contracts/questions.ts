import type { Context as ChordContext } from "@earendil-works/chord"
import { defineDoc, type ConversationId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable"
import { arr, compile, map, num, obj, opt, str, type Static, union } from "@earendil-works/pi-schema"

/** `ask_user` is a free question. Any other kind is a card: only the owner answers it, and only with one of its options. */
export const ASK_KIND = "ask_user"

/** One approval kind for both an agent's own ask and a call the tool policy holds back; only its options differ. */
export const APPROVAL_KIND = "approval"

export type AskInput = {
  readonly kind: string
  readonly threadId: ConversationId
  readonly requestId: string
  readonly question: string
  readonly options?: readonly string[]
  readonly subject?: RequestSubject
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

export type SettleOutcome =
  | { readonly kind: "answered"; readonly run: number }
  | { readonly kind: "already_answered"; readonly answer: string }

/** Runs inside the answer's commit once every check has passed, before the request closes; throwing aborts the answer. */
export type Admitted = (open: OpenRequest, tx: Tx) => Promise<void>

export interface QuestionsService {
  /** `ask_user` opens only in a thread; a card opens in any conversation: a thread, a coordinator or the root chat. */
  ask(input: AskInput, context: ChordContext): Promise<AskOutcome>
  open(conversationId: ConversationId): Promise<OpenOutcome>
  respond(api: ToolExecutionApi, threadId: number, requestId: string, answer: string): Promise<RespondOutcome>
  /**
   * Answers a card for the owner with any text, past its options: the plugin that owns the card decides the answer. The
   * next run starts with `brief`, or the answer when it is omitted. `run` is the thread's run, 0 outside a thread.
   */
  settle(
    conversationId: ConversationId,
    requestId: string,
    answer: string,
    admitted?: Admitted,
    brief?: string,
  ): Promise<SettleOutcome>
}

/** What a request is about: a card's name (a secret's ref, a service), or the gated call a policy approval holds. */
const SubjectSchema = union([str(), obj({ tool: str({ minLength: 1 }), arguments: str() })])

const RequestSchema = obj({
  kind: str({ minLength: 1 }),
  question: str(),
  options: opt(arr(str())),
  subject: opt(SubjectSchema),
  at: num(),
})
export const AnsweredSchema = obj({
  kind: str({ minLength: 1 }),
  question: str(),
  options: opt(arr(str())),
  subject: opt(SubjectSchema),
  at: num(),
  answer: str(),
  answeredAt: num(),
})
const RequestsSchema = obj({ open: map(RequestSchema), answered: map(AnsweredSchema) })

export type RequestSubject = Static<typeof SubjectSchema>
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
