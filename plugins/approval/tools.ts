import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { APPROVAL_KIND, type QuestionsService } from "../../src/contracts/questions.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-approval"
export const inject = ["pi", "questions"]

const TOOL = "request_approval"
const ANSWERS = ["Approve", "Deny"] as const

function requestApproval(questions: QuestionsService) {
  return defineTool({
    name: TOOL,
    description:
      "Ask the owner to approve one action, and end your turn. The card shows Approve and Deny, and your next run starts with the option the owner chose, Approve or Deny. Use it before an action the owner should sign off on.",
    parameters: obj({
      action: str({ minLength: 1, maxLength: 300 }),
      detail: opt(str({ minLength: 1, maxLength: 2_000 })),
    }),
    deferred: true,
    replay: "safe",
    execute: async (args, api, context) => {
      const asked = await questions.ask(
        {
          kind: APPROVAL_KIND,
          threadId: api.conversationId,
          requestId: `q:${api.taskId}`,
          question: `Approve: ${args.action}`,
          options: ANSWERS,
          subject: { tool: args.action, arguments: args.detail ?? "" },
          now: api.now(),
        },
        context,
      )
      if (asked.kind === "not_a_thread")
        return textResult(`${TOOL} is only available inside a thread.`, { isError: true })
      return textResult(`Asked the owner to approve: ${args.action}. Your next run starts with Approve or Deny.`, {
        details: asked,
        control: { terminate: true },
      })
    },
  })
}

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name, tools: [requestApproval(ctx.questions)] }))
}
