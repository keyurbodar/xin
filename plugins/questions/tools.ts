import type { JsonValue } from "@earendil-works/chord"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import type { OpenQuestion, QuestionsService } from "../../src/contracts/questions.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-questions"
export const inject = ["pi", "questions"]

const ActionSchema = oneOf(["list", "read", "respond"] as const)

function plain(request: OpenQuestion): JsonValue {
  return {
    threadId: request.threadId,
    requestId: request.requestId,
    title: request.title,
    question: request.question,
    ...(request.options === undefined ? {} : { options: [...request.options] }),
  }
}

function pick(
  open: readonly OpenQuestion[],
  threadId: number | undefined,
  requestId: string | undefined,
): OpenQuestion | undefined {
  const matching = open.filter(
    (request) =>
      (threadId === undefined || request.threadId === threadId) &&
      (requestId === undefined || request.requestId === requestId),
  )
  return matching.length === 1 ? matching[0] : undefined
}

function tools(questions: QuestionsService) {
  const askUser = defineTool({
    name: "ask_user",
    description:
      "Ask the owner a question and end your turn. The answer starts your next run. Ask only when you are blocked.",
    parameters: obj({
      question: str({ minLength: 1, maxLength: 2_000 }),
      options: opt(arr(str({ minLength: 1, maxLength: 200 }), { maxItems: 8 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const asked = await questions.ask(
        {
          threadId: api.conversationId,
          requestId: `q:${api.taskId}`,
          question: args.question,
          now: api.now(),
          ...(args.options === undefined ? {} : { options: args.options }),
        },
        context,
      )
      if (asked.kind === "not_a_thread")
        return textResult("ask_user is only available inside a thread.", { isError: true })
      return textResult(`Asked the owner: ${asked.question}`, {
        details: asked,
        control: { terminate: true },
      })
    },
  })

  const pendingRequest = defineTool({
    name: "pending_request",
    description: "List, read, or answer a thread's open question.",
    parameters: obj({
      action: ActionSchema,
      threadId: opt(int({ minimum: 0 })),
      requestId: opt(str({ minLength: 1 })),
      answer: opt(str({ minLength: 1, maxLength: 4_000 })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const opened = await questions.open(api.conversationId)
      if (opened.kind === "not_in_project")
        return textResult("This conversation is not in a project.", { isError: true })
      const open = opened.questions
      switch (args.action) {
        case "list": {
          if (open.length === 0) return textResult("No open questions.")
          return textResult(
            open.map((request) => `${request.threadId} "${request.title}": ${request.question}`).join("\n"),
            { details: { requests: open.map(plain) } },
          )
        }
        case "read": {
          const found = pick(open, args.threadId, args.requestId)
          if (found === undefined) return textResult("No matching open question.", { isError: true })
          return textResult(`${found.title} asks: ${found.question}`, { details: plain(found) })
        }
        case "respond": {
          if (args.answer === undefined) return textResult("respond needs an answer.", { isError: true })
          const found = pick(open, args.threadId, args.requestId)
          if (found === undefined) return textResult("No matching open question.", { isError: true })
          const outcome = await questions.respond(api, found.threadId, found.requestId, args.answer)
          switch (outcome.kind) {
            case "answered":
              return textResult(`Answered ${found.requestId}. The thread is running again.`, {
                details: {
                  threadId: found.threadId,
                  requestId: found.requestId,
                  kind: outcome.kind,
                  run: outcome.run,
                },
              })
            case "already_answered":
              return textResult(`already_answered: ${outcome.answer}`, {
                details: {
                  threadId: found.threadId,
                  requestId: found.requestId,
                  kind: outcome.kind,
                  answer: outcome.answer,
                },
              })
            case "refused":
              return textResult(outcome.message, { isError: true })
            default: {
              const _exhaustive: never = outcome
              return _exhaustive
            }
          }
        }
        default: {
          const _exhaustive: never = args.action
          return _exhaustive
        }
      }
    },
  })

  return [askUser, pendingRequest]
}

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name: "tool-questions", tools: tools(ctx.questions) }))
}
