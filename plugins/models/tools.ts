import type { Api, Model } from "@earendil-works/pi-ai"
import { defineExtension, defineTool, type ConversationId, type ModelRef } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { ThinkingSchema, type ModelsService } from "../../src/contracts/models.ts"
import { type Context, textResult } from "../../src/kernel/index.ts"

export const name = "tool-models"
export const inject = ["pi", "models"]

type Target =
  | { readonly kind: "conversation"; readonly id: ConversationId }
  | { readonly kind: "none"; readonly message: string }

function resolveTarget(target: string, mine: ConversationId): Target {
  if (target === "this_chat") return { kind: "conversation", id: mine }
  if (target.startsWith("thread:")) {
    const id = Number(target.slice("thread:".length))
    return Number.isSafeInteger(id) && id >= 0
      ? { kind: "conversation", id: id as ConversationId }
      : { kind: "none", message: `"${target}" is not a thread id` }
  }
  if (target === "new_threads" || target === "project_default")
    return { kind: "none", message: `"${target}" is not available yet; it arrives with projects and threads` }
  return { kind: "none", message: `unknown target "${target}"` }
}

const refOf = (model: Model<Api>): ModelRef => ({ provider: model.provider, modelId: model.id })

function setModel(models: ModelsService) {
  return defineTool({
    name: "set_model",
    description: "Switch the model a chat or thread uses. The switch applies from the next request.",
    parameters: obj({
      target: str({ minLength: 1, description: "this_chat, thread:<id>, new_threads or project_default" }),
      query: str({ minLength: 1, description: "model name, id or provider to search for" }),
      thinking: opt(ThinkingSchema),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const target = resolveTarget(args.target, api.conversationId)
      if (target.kind !== "conversation") return textResult(target.message)
      const { catalog, matches } = await models.search(args.query)
      const top = matches[0]
      if (top === undefined) {
        const words = args.query
          .toLowerCase()
          .split(/\s+/)
          .filter((word) => word.length > 1)
        const close = catalog
          .filter((model) =>
            words.some((word) => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(word)),
          )
          .slice(0, 3)
          .map((model) => `${model.provider}/${model.id} (${model.name})`)
        const hint = close.length > 0 ? `Close matches: ${close.join(", ")}. ` : ""
        const text = `No model matches "${args.query}". ${hint}Ask the owner to add a provider key in Settings.`
        return textResult(text, { isError: true })
      }
      if (matches.length > 1 && (matches[1]?.score ?? 0) === top.score) {
        const options = matches
          .slice(0, 4)
          .map((hit, index) => `${index + 1}. ${hit.model.provider}/${hit.model.id} (${hit.model.name})`)
        const text = `Which model? Several match "${args.query}": ${options.join("; ")}. Ask the owner which one, then call set_model again with the provider and id.`
        return textResult(text)
      }
      const chosen = top.model
      const outcome = await models.switchModel({
        conversation: target.id,
        caller: api.conversationId,
        model: refOf(chosen),
        ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
        callId: api.callId,
      })
      if (outcome.kind !== "ok") return textResult(outcome.message, { isError: true })
      const vision = chosen.input.includes("image")
      const notes = [
        vision ? undefined : "This model can't see images; they become placeholders.",
        chosen.reasoning ? undefined : "It has no reasoning, so thinking is off.",
      ].filter((note): note is string => note !== undefined)
      const text = [
        `Set ${chosen.provider}/${chosen.id} (${chosen.name}, ${chosen.contextWindow} tokens). It applies from the next request.`,
        ...notes,
      ].join(" ")
      return textResult(text, {
        details: {
          model: refOf(chosen),
          contextWindow: chosen.contextWindow,
          vision,
          reasoning: chosen.reasoning,
          effectiveFrom: "next request",
        },
      })
    },
  })
}

export function apply(ctx: Context): void {
  ctx.pi.install(defineExtension({ name: "tool-models", tools: [setModel(ctx.models)] }))
}
