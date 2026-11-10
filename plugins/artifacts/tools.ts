import type { JsonValue } from "@earendil-works/chord"
import { defineExtension, defineTool, type Harness, type ToolRegistration } from "@earendil-works/pi-durable"
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema"
import { ARTIFACT_MARKDOWN_MAX } from "../../src/contracts/artifacts.ts"
import { scopeOf } from "../../src/contracts/scope.ts"
import type { CommandId } from "../../src/ids.ts"
import type { Context } from "../../src/kernel/index.ts"
import { textResult } from "../../src/kernel/index.ts"
import type { Actor, Command, Outcome } from "../../src/ops.ts"

export const name = "tool-artifacts"
export const inject = ["pi", "harness", "ops"]

const Actions = ["list", "read", "write", "delete"] as const
const commandId = (value: string): CommandId => value as CommandId

export type ArtifactToolPort = {
  readonly harness: Harness
  run(command: Command, actor: Actor): Promise<Outcome>
}

const recordOf = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined

const textOf = (value: JsonValue | undefined): string | undefined => (typeof value === "string" ? value : undefined)

const numberText = (value: JsonValue | undefined): string => (typeof value === "number" ? String(value) : "?")

export function apply(ctx: Context): void {
  ctx.pi.install(
    defineExtension({
      name,
      tools: [artifactTool({ harness: ctx.harness, run: (command, actor) => ctx.ops.run(command, actor) })],
    }),
  )
}

export function artifactTool(port: ArtifactToolPort): ToolRegistration {
  return defineTool({
    name: "artifact",
    description:
      "Read and write documents attached to a thread. A thread writes its own; a Space or Puck passes threadId. Every save bumps the revision; pass expectedRevision to avoid overwriting a newer save.",
    parameters: obj({
      action: oneOf(Actions),
      threadId: opt(int({ minimum: 0 })),
      id: opt(str({ minLength: 1 })),
      title: opt(str({ minLength: 1, maxLength: 200 })),
      markdown: opt(str({ maxLength: ARTIFACT_MARKDOWN_MAX })),
      expectedRevision: opt(int({ minimum: 1 })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const scope = await scopeOf(port.harness, api.conversationId)
      const threadId = args.threadId ?? (scope?.kind === "thread" ? scope.threadId : undefined)
      if (threadId === undefined)
        return textResult("Pass threadId when calling artifact from a Space or Puck.", { isError: true })
      if ((args.action === "read" || args.action === "delete") && args.id === undefined)
        return textResult(`artifact ${args.action} needs an id.`, { isError: true })
      if (args.action === "write" && (args.title === undefined || args.markdown === undefined))
        return textResult("artifact write needs a title and markdown.", { isError: true })

      const call = {
        threadId,
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.markdown === undefined ? {} : { markdown: args.markdown }),
        ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
      }
      const outcome = await port.run(
        { id: commandId(`artifact.${args.action}:${api.taskId}`), op: `artifact.${args.action}`, args: call },
        { kind: "agent", conversationId: api.conversationId },
      )
      if (outcome.kind !== "ok") return textResult(outcome.message, { isError: true })
      const result = recordOf(outcome.result)
      switch (args.action) {
        case "list": {
          const listed = result?.["artifacts"]
          if (!Array.isArray(listed) || listed.length === 0) return textResult("No artifacts.")
          const lines = listed.map((entry) => {
            const artifact = recordOf(entry)
            return `${textOf(artifact?.["id"]) ?? "?"} [rev ${numberText(artifact?.["revision"])}] ${textOf(artifact?.["title"]) ?? ""}`
          })
          return textResult(lines.join("\n"), { details: outcome.result })
        }
        case "read": {
          const id = textOf(result?.["id"]) ?? args.id ?? "?"
          const title = textOf(result?.["title"]) ?? ""
          const markdown = textOf(result?.["markdown"]) ?? ""
          return textResult(`Artifact ${id} "${title}" (revision ${numberText(result?.["revision"])})\n\n${markdown}`, {
            details: outcome.result,
          })
        }
        case "write": {
          if (textOf(result?.["kind"]) === "stale") {
            const revision = numberText(result?.["revision"])
            return textResult(
              `Revision ${revision} is current; merge your change and retry with expectedRevision ${revision}.\n\n${textOf(result?.["markdown"]) ?? ""}`,
              { details: outcome.result },
            )
          }
          const id = textOf(result?.["id"]) ?? "?"
          return textResult(`Saved artifact ${id} at revision ${numberText(result?.["revision"])}.`, {
            details: outcome.result,
          })
        }
        case "delete":
          return textResult(`Deleted artifact ${textOf(result?.["id"]) ?? args.id ?? "?"}.`, {
            details: outcome.result,
          })
      }
    },
  })
}
