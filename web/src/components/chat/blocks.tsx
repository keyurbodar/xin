import { ErrorBoundary, untrack, type JSX } from "solid-js"
import { CodeBlock } from "./code-block.tsx"
import { MermaidBlock } from "./mermaid-block.tsx"
import { fenceRenderer, toolRenderer, type BlockPayloads } from "./registry.ts"
import { TableBlock } from "./table-block.tsx"
import { tableMarkdown } from "./table-copy.ts"

export { hasBlock, registerBlock, type BlockKind, type BlockPayloads } from "./registry.ts"

const BUILT_IN: { [K in keyof BlockPayloads]: (payload: BlockPayloads[K]) => JSX.Element } = {
  code: (code) => {
    const fence = fenceRenderer(code.lang)
    if (fence === undefined) return untrack(() => <CodeBlock {...code} />)
    return untrack(() =>
      fence({
        get source() {
          return code.source
        },
        get streaming() {
          return code.streaming
        },
      }),
    )
  },
  mermaid: (diagram) => untrack(() => <MermaidBlock {...diagram} />),
  table: (table) => untrack(() => <TableBlock {...table} />),
  tool: (call) => {
    const tool = toolRenderer(untrack(() => call.name))
    return tool === undefined ? undefined : untrack(() => tool(call))
  },
}

const FALLBACK: { [K in keyof BlockPayloads]: (payload: BlockPayloads[K]) => JSX.Element } = {
  code: (code) => <CodeBlock lang={code.lang} source={code.source} streaming={code.streaming} />,
  mermaid: (diagram) => <CodeBlock lang="mermaid" source={diagram.source} streaming={diagram.streaming} />,
  table: (table) => (
    <CodeBlock lang="markdown" source={tableMarkdown(table.header, table.align, table.rows)} streaming={table.streaming} />
  ),
  tool: () => undefined,
}

export function renderBlock<K extends keyof BlockPayloads>(kind: K, payload: BlockPayloads[K]): JSX.Element {
  const render: (payload: BlockPayloads[K]) => JSX.Element = BUILT_IN[kind]
  const fallback: (payload: BlockPayloads[K]) => JSX.Element = FALLBACK[kind]
  return <ErrorBoundary fallback={() => fallback(payload)}>{render(payload)}</ErrorBoundary>
}
