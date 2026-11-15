import { createSignal } from "solid-js"
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

const [reports, setReports] = createSignal<ReadonlyMap<number, ContextReport>>(new Map())
const inFlight = new Map<number, Promise<ContextReport>>()

export function cachedContext(conv: number): ContextReport | undefined {
  return reports().get(conv)
}

export function refreshContext(conv: number): Promise<ContextReport> {
  const pending = inFlight.get(conv)
  if (pending !== undefined) return pending
  const read = cmd<unknown>("conv.context", { conv })
    .then(parseContextReport)
    .then((report) => {
      setReports((current) => new Map(current).set(conv, report))
      return report
    })
    .finally(() => inFlight.delete(conv))
  inFlight.set(conv, read)
  return read
}

/** The last report for a conversation, read once; later reads come only from a finished turn or an opened popover. */
export function ensureContext(conv: number): Promise<ContextReport> {
  const known = reports().get(conv)
  return known === undefined ? refreshContext(conv) : Promise.resolve(known)
}
