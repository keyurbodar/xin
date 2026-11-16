import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
import type { QuestionsService } from "../../src/contracts/questions.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-connect"
export const inject = ["pi", "questions"]

const CONNECT_KIND = "request_connection"
const CONNECT_ANSWERS = ["connected", "declined"] as const

function requestConnection(questions: QuestionsService) {
  return defineTool({
    name: CONNECT_KIND,
    description:
      "Ask the owner to connect a service (an MCP server or a provider key) from a card that opens the connectors page, and end your turn. The answer, connected or declined, starts your next run.",
    parameters: obj({
      service: str({ minLength: 1, maxLength: 100 }),
      reason: str({ minLength: 1, maxLength: 500 }),
    }),
    deferred: true,
    replay: "safe",
    execute: async (args, api, context) => {
      const asked = await questions.ask(
        {
          kind: CONNECT_KIND,
          threadId: api.conversationId,
          requestId: `q:${api.taskId}`,
          question: `Connect ${args.service}: ${args.reason}`,
          options: CONNECT_ANSWERS,
          subject: args.service,
          now: api.now(),
        },
        context,
      )
      if (asked.kind === "not_a_thread")
        return textResult(`${CONNECT_KIND} is only available inside a thread.`, { isError: true })
      return textResult(`Asked the owner to connect ${args.service}.`, {
        details: asked,
        control: { terminate: true },
      })
    },
  })
}

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name, tools: [requestConnection(ctx.questions)] }))
  ctx.pi.search()
}
