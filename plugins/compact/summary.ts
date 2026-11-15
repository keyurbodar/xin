import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate"
import {
  AgentDoc,
  type CompactionHooks,
  type ConversationId,
  DEFAULT_COMPACTION_POLICY,
  type Harness,
  ProviderDoc,
  UsageDoc,
} from "@earendil-works/pi-durable"
import { type ModelDefaults, resolveModel } from "../../src/contracts/models.ts"

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
  readonly harness: Pick<Harness, "commit">
}

/** pi's `recordUsage` (not exported in 1.5): add the response's usage to the conversation's `pi.usage`, so it reaches `usage_daily` and the spend cap. */
function chargeUsage(harness: SummaryPorts["harness"], conversationId: ConversationId, message: AssistantMessage) {
  const key = `${message.provider}/${message.model}`
  const { usage } = message
  return harness.commit(async (tx) => {
    const models = (await tx.doc(UsageDoc, conversationId)).models
    if (!Object.hasOwn(models, key))
      models[key] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }
    const total = models[key]
    if (total === undefined) return
    total.input += usage.input
    total.output += usage.output
    total.cacheRead += usage.cacheRead
    total.cacheWrite += usage.cacheWrite
    total.totalTokens += usage.totalTokens
    if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h
    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning
    total.cost.input += usage.cost.input
    total.cost.output += usage.cost.output
    total.cost.cacheRead += usage.cost.cacheRead
    total.cost.cacheWrite += usage.cost.cacheWrite
    total.cost.total += usage.cost.total
  }, BACKGROUND_CONTEXT)
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

async function summarizeOnUtility(
  compaction: Compaction,
  source: string,
  api: HookApi,
  context: HookContext,
  ports: SummaryPorts,
): Promise<string | undefined> {
  const utility = resolveModel({ role: "utility", owner: await ports.ownerDefaults() })
  if (utility.kind === "none") return undefined
  const current = (await api.snapshot(AgentDoc, api.conversationId, context))?.model
  if (current?.provider === utility.model.provider && current.modelId === utility.model.modelId) return undefined
  const model = api.models.getModel(utility.model.provider, utility.model.modelId)
  if (model === undefined) return undefined
  const focus = compaction.instructions === undefined ? "" : `\n\nAdditional focus: ${compaction.instructions}`
  const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId
  const reserve = Math.floor(0.8 * DEFAULT_COMPACTION_POLICY.reserveTokens)
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
    await chargeUsage(ports.harness, api.conversationId, message)
    return summaryText(message)
  } catch {
    return undefined
  }
}

/**
 * `beforeCompact`: a threshold compaction whose source has a long tool result, and fits `PRUNED_BUDGET_TOKENS` once
 * those are cut, is placed as that pruned source with no model call; anything else is summarized on the owner's
 * utility model, its usage charged to the conversation like pi's own summary, or left to pi's summarizer on the
 * conversation's model when there is none, it is the same model, or the call fails.
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
    const summary = await summarizeOnUtility(compaction, source.text, api, context, ports)
    return summary === undefined ? undefined : { summary }
  }
}
