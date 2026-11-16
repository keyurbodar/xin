import { rowId } from "../../src/contributions.ts"
import type { Context } from "../../src/kernel/index.ts"

export const name = "standup"
export const inject = ["prompts"]

export function apply(ctx: Context): void {
  ctx.prompts.contribute(
    {
      name: "standup",
      description: "Write my standup from today's conversations.",
      text: "Write my standup: what I finished, what I am working on, and what is blocked. Use the threads and conversations from the last day, one short bullet each.",
    },
    rowId(ctx),
  )
}
