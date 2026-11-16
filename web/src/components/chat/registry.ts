import { createSignal, type JSX } from "solid-js"
import type { Align } from "./markdown-parse.ts"

export type BlockPayloads = {
  code: { lang: string; source: string; streaming: boolean }
  mermaid: { source: string; streaming: boolean }
  table: { header: string[]; align: Align[]; rows: string[][]; streaming: boolean }
  tool: {
    name: string
    callId: string
    args: Record<string, unknown>
    output?: string
    status: "streaming" | "running" | "done" | "error"
  }
}

export type BlockKind = keyof BlockPayloads | `fence:${string}` | `tool:${string}`

export type FencePayload = BlockPayloads["mermaid"]
export type FenceRender = (payload: FencePayload) => JSX.Element
export type ToolRender = (payload: BlockPayloads["tool"]) => JSX.Element

type Entry = [`fence:${string}`, FenceRender] | [`tool:${string}`, ToolRender]

type Registry = { fence: ReadonlyMap<string, FenceRender>; tool: ReadonlyMap<string, ToolRender> }

const [registry, setRegistry] = createSignal<Registry>({ fence: new Map(), tool: new Map() })

const BUILT_IN = new Set<string>(["code", "mermaid", "table", "tool"])

function isFence(entry: Entry): entry is [`fence:${string}`, FenceRender] {
  return entry[0].startsWith("fence:")
}

function updated<T>(map: ReadonlyMap<string, T>, key: string, value: T | undefined, only?: T): ReadonlyMap<string, T> {
  const next = new Map(map)
  if (value !== undefined) next.set(key, value)
  else if (only === undefined || next.get(key) === only) next.delete(key)
  return next
}

export function registerBlock(kind: `fence:${string}`, render: FenceRender): () => void
export function registerBlock(kind: `tool:${string}`, render: ToolRender): () => void
export function registerBlock(...entry: Entry): () => void {
  if (isFence(entry)) {
    const [kind, render] = entry
    const key = kind.slice("fence:".length)
    setRegistry((current) => ({ ...current, fence: updated(current.fence, key, render) }))
    return () => setRegistry((current) => ({ ...current, fence: updated(current.fence, key, undefined, render) }))
  }
  const [kind, render] = entry
  const key = kind.slice("tool:".length)
  setRegistry((current) => ({ ...current, tool: updated(current.tool, key, render) }))
  return () => setRegistry((current) => ({ ...current, tool: updated(current.tool, key, undefined, render) }))
}

export function hasBlock(kind: BlockKind): boolean {
  if (BUILT_IN.has(kind)) return true
  if (kind.startsWith("fence:")) return registry().fence.has(kind.slice("fence:".length))
  return kind.startsWith("tool:") && registry().tool.has(kind.slice("tool:".length))
}

export function fenceRenderer(lang: string): FenceRender | undefined {
  return registry().fence.get(lang)
}

export function toolRenderer(name: string): ToolRender | undefined {
  return registry().tool.get(name)
}
