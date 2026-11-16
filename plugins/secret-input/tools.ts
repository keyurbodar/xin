import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, str } from "@earendil-works/pi-schema"
import type { QuestionsService } from "../../src/contracts/questions.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"
import { FragmentId } from "../../src/rowid.ts"
import { SECRET_KIND } from "./secret.ts"

export const name = "tool-secret-input"
export const inject = ["pi", "questions"]

function requestSecret(questions: QuestionsService) {
  return defineTool({
    name: SECRET_KIND,
    description:
      "Ask the owner for a password, token or key from a masked card, and end your turn. The value goes straight to the secret store under `name`; you never see it, only \"stored as <name>\" or \"declined\" in your next run. Never ask for a secret any other way.",
    parameters: obj({
      name: FragmentId,
      label: str({ minLength: 1, maxLength: 200 }),
      reason: str({ minLength: 1, maxLength: 500 }),
    }),
    deferred: true,
    replay: "safe",
    execute: async (args, api, context) => {
      const asked = await questions.ask(
        {
          kind: SECRET_KIND,
          threadId: api.conversationId,
          requestId: `q:${api.taskId}`,
          question: `${args.label} (${args.name}): ${args.reason}`,
          subject: args.name,
          now: api.now(),
        },
        context,
      )
      if (asked.kind === "not_a_thread")
        return textResult(`${SECRET_KIND} is only available inside a thread.`, { isError: true })
      return textResult(`Asked the owner for ${args.name}.`, { details: asked, control: { terminate: true } })
    },
  })
}

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name, tools: [requestSecret(ctx.questions)] }))
  ctx.pi.search()
}
