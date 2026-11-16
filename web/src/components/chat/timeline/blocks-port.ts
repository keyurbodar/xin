import { createComponent, createSignal, type JSX } from "solid-js"
import { Markdown as PlainMarkdown } from "../markdown.tsx"

export type BlockPayloads = {
  code: { lang: string; source: string; streaming: boolean }
  mermaid: { source: string; streaming: boolean }
  table: { header: string[]; align: ("left" | "center" | "right")[]; rows: string[][]; streaming: boolean }
  tool: {
    name: string
    callId: string
    args: Record<string, unknown>
    output?: string
    status: "streaming" | "running" | "done" | "error"
  }
}

export type BlockKind = keyof BlockPayloads | `fence:${string}` | `tool:${string}`

type FencePayload = { source: string; streaming: boolean }
type Render = { bivariant(payload: FencePayload | BlockPayloads["tool"]): JSX.Element }["bivariant"]

const [registry, setRegistry] = createSignal<ReadonlyMap<string, Render>>(new Map())

export function registerBlock(kind: `fence:${string}`, render: (payload: FencePayload) => JSX.Element): () => void
export function registerBlock(kind: `tool:${string}`, render: (payload: BlockPayloads["tool"]) => JSX.Element): () => void
export function registerBlock(
  kind: `fence:${string}` | `tool:${string}`,
  render: ((payload: FencePayload) => JSX.Element) | ((payload: BlockPayloads["tool"]) => JSX.Element),
): () => void {
  setRegistry((current) => new Map<string, Render>(current).set(kind, render))
  return () =>
    setRegistry((current) => {
      if (current.get(kind) !== render) return current
      const next = new Map(current)
      next.delete(kind)
      return next
    })
}

export function hasBlock(kind: BlockKind): boolean {
  return registry().has(kind)
}

export function renderBlock<K extends keyof BlockPayloads>(kind: K, payload: BlockPayloads[K]): JSX.Element
export function renderBlock(kind: keyof BlockPayloads, payload: BlockPayloads[keyof BlockPayloads]): JSX.Element {
  if (kind !== "tool" || !("callId" in payload)) return undefined
  return registry().get(`tool:${payload.name}`)?.(payload)
}

export function Markdown(props: { text: string; streaming?: boolean }): JSX.Element {
  return createComponent(PlainMarkdown, {
    get text() {
      return props.text
    },
  })
}
