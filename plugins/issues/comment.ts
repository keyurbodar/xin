import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema"
import type { Context } from "../../src/kernel/index.ts"
import { type IssueToolPort, refusing, write } from "./tools.ts"

export const name = "tool-issue-comment"
export const inject = ["pi", "issues", "ops"]

export function apply(ctx: Context): void {
  const port: IssueToolPort = { issues: ctx.issues, run: (command, actor) => ctx.ops.run(command, actor) }
  ctx.pi.install(defineExtension({ name: "tool-issue-comment", tools: [commentTool(port)] }))
}

export function commentTool(port: IssueToolPort) {
  return defineTool({
    name: "issue_comment",
    description: "Comment on an issue; mentions are conversation ids to wake.",
    parameters: obj({ id: int(), body: str(), mentions: opt(arr(int())) }),
    replay: "safe",
    execute: async ({ id, body, mentions }, api) =>
      refusing(async () => {
        const result = await write(port, api, "issue.comment", {
          id,
          body,
          ...(mentions === undefined ? {} : { mentions }),
        })
        const event = typeof result === "object" && result !== null && !Array.isArray(result) ? result["event"] : null
        const eventId = typeof event === "object" && event !== null && !Array.isArray(event) ? event["id"] : undefined
        return `Commented on #${id} (comment ${typeof eventId === "number" ? eventId : "?"}).`
      }),
  })
}
