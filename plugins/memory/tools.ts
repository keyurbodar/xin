import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import type { MemoryService } from "../../src/contracts/memory.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"
import { projectInScope } from "../../src/contracts/threaddoc.ts"
import { isScope, refusal, SCOPE_PATTERN } from "./dreamprompt.ts"

export const name = "tool-memory"
export const inject = ["pi", "memory"]

export function apply(ctx: Context): void {
  const memory = ctx.memory
  ctx.pi.install(
    defineExtension({
      name: "tool-memory",
      tools: [remember(memory), recall(memory)],
      sections: [profileSection(memory)],
    }),
  )
}

function remember(memory: MemoryService) {
  return defineTool({
    name: "remember",
    description: "Save one durable fact about the owner or a project, for later recall.",
    parameters: obj({
      text: str({ minLength: 1, maxLength: 2000 }),
      scope: opt(str({ pattern: SCOPE_PATTERN })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const text = args.text.trim()
      if (text.length === 0) return refused("empty text")
      const project = await projectInScope(api, api.conversationId)
      const own = project === undefined ? undefined : `project:${project.projectId}`
      const scope = args.scope ?? own ?? "me"
      if (!isScope(scope)) return refused(`unknown scope ${scope}`)
      if (scope !== "me" && scope !== own) return refused(`scope ${scope} belongs to another conversation`)
      const denied = refusal(text)
      if (denied !== undefined) return refused(denied)
      const inserted = await memory.remember({
        text,
        scope,
        source: "remember",
        originTask: String(api.taskId),
        at: Date.now(),
      })
      return textResult(inserted ? `Remembered (${scope}).` : `Already remembered (${scope}).`)
    },
  })
}

function recall(memory: MemoryService) {
  return defineTool({
    name: "recall",
    description: "Search saved notes by keyword, newest and most relevant first.",
    parameters: obj({
      q: str({ minLength: 1, maxLength: 200 }),
      scope: opt(str({ pattern: SCOPE_PATTERN })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const project = await projectInScope(api, api.conversationId)
      const allowed = project === undefined ? ["me"] : ["me", `project:${project.projectId}`]
      if (args.scope !== undefined) {
        if (!isScope(args.scope)) return notRecalled(`unknown scope ${args.scope}`)
        if (!allowed.includes(args.scope)) return notRecalled(`scope ${args.scope} belongs to another conversation`)
      }
      const notes = await memory.search(args.q, args.scope === undefined ? allowed : [args.scope], Date.now())
      if (notes.length === 0) return textResult("No matching notes.")
      return textResult(notes.map((note) => `- [${note.scope}] ${note.text}`).join("\n"))
    },
  })
}

function profileSection(memory: MemoryService) {
  return section("profile", async () => {
    const text = await memory.profile()
    return text.trim().length === 0 ? undefined : text
  })
}

function refused(reason: string) {
  return textResult(`Not saved: ${reason}.`, { isError: true })
}

function notRecalled(reason: string) {
  return textResult(`Cannot recall: ${reason}.`, { isError: true })
}
