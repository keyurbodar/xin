import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import type { QuestionsService } from "../../src/contracts/questions.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-approval"
export const inject = ["pi", "questions"]

const APPROVAL_KIND = "request_approval"
const APPROVAL_ANSWERS = ["approved", "declined"] as const

function requestApproval(questions: QuestionsService) {
  return defineTool({
    name: APPROVAL_KIND,
    description:
      "Ask the owner to approve one action, and end your turn. The card shows Approve and Decline; the decision, approved or declined, starts your next run. Use it before an action the owner should sign off on.",
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
          options: APPROVAL_ANSWERS,
          now: api.now(),
        },
        context,
      )
      if (asked.kind === "not_a_thread")
        return textResult(`${APPROVAL_KIND} is only available inside a thread.`, { isError: true })
      return textResult(`Asked the owner to approve: ${args.action}`, {
        details: asked,
        control: { terminate: true },
      })
    },
  })
}

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name, tools: [requestApproval(ctx.questions)] }))
}
