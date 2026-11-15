import { cmd } from "../lib/api.ts"
import { listOf, numOf, recordOf, strOf } from "../lib/parse.ts"

export type ContextCategoryKey = "system" | "tools" | "conversation"

export type ContextCategory = { readonly key: ContextCategoryKey; readonly tokens: number }

export type ContextReport = {
  readonly conversation: number
  readonly model: { readonly provider: string; readonly modelId: string } | undefined
  readonly contextWindow: number
  readonly used: number
  readonly measured: boolean
  readonly categories: readonly ContextCategory[]
  readonly compactAt: number
}

const isCategoryKey = (value: string | undefined): value is ContextCategoryKey =>
  value === "system" || value === "tools" || value === "conversation"

export function parseContextReport(value: unknown): ContextReport {
  const root = recordOf(value)
  const conversation = numOf(root?.conversation)
  const contextWindow = numOf(root?.contextWindow)
  const used = numOf(root?.used)
  const compactAt = numOf(root?.compactAt)
  if (conversation === undefined || contextWindow === undefined || used === undefined || compactAt === undefined)
    throw new Error("conv.context answered an unexpected shape")
  const model = recordOf(root?.model)
  const provider = strOf(model?.provider)
  const modelId = strOf(model?.modelId)
  return {
    conversation,
    model: provider === undefined || modelId === undefined ? undefined : { provider, modelId },
    contextWindow,
    used,
    measured: root?.measured === true,
    categories: listOf(root?.categories).flatMap((entry) => {
      const record = recordOf(entry)
      const key = strOf(record?.key)
      const tokens = numOf(record?.tokens)
      return isCategoryKey(key) && tokens !== undefined ? [{ key, tokens }] : []
    }),
    compactAt,
  }
}

export async function readContext(conv: number): Promise<ContextReport> {
  return parseContextReport(await cmd<unknown>("conv.context", { conv }))
}
