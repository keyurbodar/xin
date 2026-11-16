import { createSignal } from "solid-js"
import { cmd, OpError } from "../lib/api.ts"
import { coalesce } from "../lib/requests.ts"
import { parseRequestList, parseSettledList, type RequestRow, type SettledRow } from "./conversation.ts"

type InboxQuestion = RequestRow

const [questions, setQuestions] = createSignal<readonly InboxQuestion[]>([])
const [settled, setSettled] = createSignal<readonly SettledRow[]>([])
export const openRequests = questions
export const settledRequests = settled

async function fetchQuestions(): Promise<void> {
  try {
    const result = await cmd<unknown>("request.list", {})
    setQuestions(parseRequestList(result))
    setSettled(parseSettledList(result))
  } catch (problem) {
    if (problem instanceof OpError && problem.code === "unknown_op") setQuestions([])
    else throw problem
  }
}

export const refreshRequests = coalesce(fetchQuestions)

function settle(question: InboxQuestion, answer: string): void {
  setQuestions((current) => current.filter((entry) => entry.id !== question.id))
  setSettled((current) => [
    { id: question.id, kind: question.kind, conversationId: question.conversationId, answer, answeredAt: Date.now() },
    ...current.filter((entry) => entry.id !== question.id),
  ])
  void refreshRequests()
}

export async function respondToQuestion(question: InboxQuestion, answer: string): Promise<void> {
  await cmd("request.respond", { threadId: question.conversationId, requestId: question.id, answer })
  settle(question, answer)
}

/** Sends a secret card's value straight to the secret store; this client only ever records the name it went under. */
export async function provideSecret(question: InboxQuestion, name: string, value: string | undefined): Promise<void> {
  await cmd("secret.provide", {
    threadId: question.conversationId,
    requestId: question.id,
    ...(value === undefined ? {} : { value }),
  })
  settle(question, value === undefined ? "declined" : `stored as ${name}`)
}
