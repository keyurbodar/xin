import { createSignal } from "solid-js"
import { cmd, OpError } from "../lib/api.ts"
import { coalesce } from "../lib/requests.ts"
import { parseRequestList, type RequestRow } from "./conversation.ts"

type InboxQuestion = RequestRow

const [questions, setQuestions] = createSignal<readonly InboxQuestion[]>([])
export const openRequests = questions

async function fetchQuestions(): Promise<void> {
  try {
    const result = await cmd<unknown>("request.list", {})
    setQuestions(parseRequestList(result))
  } catch (problem) {
    if (problem instanceof OpError && problem.code === "unknown_op") setQuestions([])
    else throw problem
  }
}

export const refreshRequests = coalesce(fetchQuestions)

export async function respondToQuestion(question: InboxQuestion, answer: string): Promise<void> {
  await cmd("request.respond", { threadId: question.conversationId, requestId: question.id, answer })
  setQuestions((current) => current.filter((entry) => entry.id !== question.id))
  void refreshRequests()
}
