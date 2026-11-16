import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate"
import {
  AgentDoc,
  type CompactionHooks,
  type ConversationId,
  DEFAULT_COMPACTION_POLICY,
  ProviderDoc,
} from "@earendil-works/pi-durable"
import { type Admission, type ModelDefaults, resolveModel } from "../../src/contracts/models.ts"

/** Longest tool result text a summary source keeps verbatim; longer ones keep half of this from each end. */
const TOOL_RESULT_CAP = 2000
/** Largest pruned transcript placed as the summary itself: a quarter of pi's default `keepRecentTokens`. */
const PRUNED_BUDGET_TOKENS = 5000
const PRUNED_PREFIX =
  "Earlier messages, verbatim except that long tool results were cut to their head and tail; the full results stay in the journal.\n\n"

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

type Compaction = Parameters<CompactionHooks["beforeCompact"]>[0]
type HookApi = Parameters<CompactionHooks["beforeCompact"]>[1]
type HookContext = Parameters<CompactionHooks["beforeCompact"]>[2]

export type SummaryPorts = {
  readonly ownerDefaults: () => Promise<ModelDefaults>
  readonly admit: () => Promise<Admission>
  readonly charge: (conversation: ConversationId, message: AssistantMessage) => Promise<void>
}

function prune(text: string): { readonly text: string; readonly pruned: boolean } {
  if (text.length <= TOOL_RESULT_CAP) return { text, pruned: false }
  const keep = TOOL_RESULT_CAP / 2
  const head = text.slice(0, keep)
  const tail = text.slice(-keep)
  return { text: `${head}\n[… ${text.length - TOOL_RESULT_CAP} chars pruned …]\n${tail}`, pruned: true }
}

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
}

/** pi's summary source (`serializeConversation`, system messages omitted), with every long tool result cut to its head and tail. */
function serialize(messages: readonly Message[]): { readonly text: string; readonly pruned: number } {
  const parts: string[] = []
  let pruned = 0
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break
      case "user": {
        const text = contentText(message.content)
        if (text.length > 0) parts.push(`[User]: ${text}`)
        break
      }
      case "assistant": {
        const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        const calls = message.content.flatMap((block) =>
          block.type === "toolCall"
            ? [
                `${block.name}(${Object.entries(block.arguments)
                  .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                  .join(", ")})`,
              ]
            : [],
        )
        if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`)
        if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`)
        break
      }
      case "toolResult": {
        const result = prune(contentText(message.content))
        if (result.pruned) pruned += 1
        if (result.text.length > 0) parts.push(`[Tool result]: ${result.text}`)
        break
      }
      default: {
        const _exhaustive: never = message
        throw new Error(`unknown message ${JSON.stringify(_exhaustive)}`)
      }
    }
  }
  return { text: parts.join("\n\n"), pruned }
}

function summaryText(message: AssistantMessage): string | undefined {
  if (message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return undefined
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
  return text.length === 0 ? undefined : text
}

async function summarize(
  compaction: Compaction,
  source: string,
  api: HookApi,
  context: HookContext,
  ports: SummaryPorts,
): Promise<string | undefined> {
  const utility = resolveModel({ role: "utility", owner: await ports.ownerDefaults() })
  const current = (await api.snapshot(AgentDoc, api.conversationId, context))?.model
  const refs = [...(utility.kind === "none" ? [] : [utility.model]), ...(current === undefined ? [] : [current])]
  const models = refs
    .filter(
      (ref, index) =>
        refs.findIndex((other) => other.provider === ref.provider && other.modelId === ref.modelId) === index,
    )
    .flatMap((ref) => {
      const model = api.models.getModel(ref.provider, ref.modelId)
      return model === undefined ? [] : [model]
    })
  const focus = compaction.instructions === undefined ? "" : `\n\nAdditional focus: ${compaction.instructions}`
  const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId
  const reserve = Math.floor(0.8 * DEFAULT_COMPACTION_POLICY.reserveTokens)
  for (const model of models) {
    try {
      const message = await api.models.completeSimple(
        model,
        {
          systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `<conversation>\n${source}\n</conversation>\n\n${SUMMARIZATION_PROMPT}${focus}` },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          cacheRetention: "none",
          maxTokens: model.maxTokens > 0 ? Math.min(reserve, model.maxTokens) : reserve,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        },
      )
      await ports.charge(api.conversationId, message)
      const summary = summaryText(message)
      if (summary !== undefined) return summary
    } catch {
      if (context.abortSignal?.aborted === true) return undefined
    }
  }
  return undefined
}

/**
 * `beforeCompact`: a threshold compaction whose source has a long tool result, and fits `PRUNED_BUDGET_TOKENS` once
 * those are cut, is placed as that pruned source with no model call; anything else is summarized here, on the owner's
 * utility model and then on the conversation's own model when there is no utility model or its call fails, so every
 * summary's usage is charged as `compaction`. pi's summarizer runs only when both calls fail.
 */
export function beforeCompact(ports: SummaryPorts): CompactionHooks["beforeCompact"] {
  return async (compaction, api, context) => {
    const source = serialize(compaction.messages)
    if (
      compaction.reason === "threshold" &&
      source.pruned > 0 &&
      estimateTextTokens(source.text) <= PRUNED_BUDGET_TOKENS
    )
      return { summary: `${PRUNED_PREFIX}${source.text}` }
    if ((await ports.admit()).kind === "capped") return { decline: true }
    const summary = await summarize(compaction, source.text, api, context, ports)
    return summary === undefined ? undefined : { summary }
  }
}
