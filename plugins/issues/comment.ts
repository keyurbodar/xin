import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema"
import type { Context } from "../../src/kernel/index.ts"
import type { IssuesService } from "./issues.ts"
import { refusing } from "./tools.ts"

export const name = "tool-issue-comment"
export const inject = ["pi", "issues"]

export function apply(ctx: Context): void {
  const issues = ctx.issues
  ctx.pi.install(defineExtension({ name: "tool-issue-comment", tools: [commentTool(issues)] }))
}

function commentTool(issues: IssuesService) {
  return defineTool({
    name: "issue_comment",
    description: "Comment on an issue. replyTo: top comment id; mentions: conv ids to wake.",
    parameters: obj({ id: int(), body: str(), replyTo: opt(int()), mentions: opt(arr(int())) }),
    replay: "unsafe",
    execute: async ({ id, body, replyTo, mentions }, api) =>
      refusing(async () => {
        const { events } = await issues.comment({ kind: "thread", id: api.conversationId }, id, {
          body,
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(mentions === undefined ? {} : { mentions }),
        })
        return `Commented on #${id} (comment ${events[0]?.id ?? "?"}).`
      }),
  })
}
