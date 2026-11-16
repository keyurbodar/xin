import { For, Index, Match, Switch, createMemo, type Accessor, type JSX } from "solid-js"
import { renderBlock } from "./blocks.tsx"
import { inline } from "./inline.tsx"
import { parseBlocks, settle, type MarkdownBlock } from "./markdown-parse.ts"

type Of<K extends MarkdownBlock["kind"]> = Extract<MarkdownBlock, { kind: K }>

function Block(props: { block: Accessor<MarkdownBlock> }): JSX.Element {
  const fence = (): Of<"fence"> | undefined => {
    const block = props.block()
    return block.kind === "fence" ? block : undefined
  }
  const table = (): Of<"table"> | undefined => {
    const block = props.block()
    return block.kind === "table" ? block : undefined
  }
  const heading = (): Of<"heading"> | undefined => {
    const block = props.block()
    return block.kind === "heading" ? block : undefined
  }
  const list = (): Of<"list"> | undefined => {
    const block = props.block()
    return block.kind === "list" ? block : undefined
  }
  const quote = (): Of<"quote"> | undefined => {
    const block = props.block()
    return block.kind === "quote" ? block : undefined
  }
  const paragraph = (): Of<"paragraph"> | undefined => {
    const block = props.block()
    return block.kind === "paragraph" ? block : undefined
  }
  const mermaid = (): boolean => fence()?.lang === "mermaid"

  return (
    <Switch>
      <Match when={fence() !== undefined && mermaid()}>
        {renderBlock("mermaid", {
          get source() {
            return fence()?.source ?? ""
          },
          get streaming() {
            return fence()?.streaming ?? false
          },
        })}
      </Match>
      <Match when={fence() !== undefined}>
        {renderBlock("code", {
          get lang() {
            return fence()?.lang ?? ""
          },
          get source() {
            return fence()?.source ?? ""
          },
          get streaming() {
            return fence()?.streaming ?? false
          },
        })}
      </Match>
      <Match when={table() !== undefined}>
        {renderBlock("table", {
          get header() {
            return table()?.header ?? []
          },
          get align() {
            return table()?.align ?? []
          },
          get rows() {
            return table()?.rows ?? []
          },
          get streaming() {
            return table()?.streaming ?? false
          },
        })}
      </Match>
      <Match when={heading()}>
        {(current) => <div class="mt-1 text-[15px] font-medium leading-[1.4] text-ink">{inline(current().text)}</div>}
      </Match>
      <Match when={list()?.ordered === false ? list() : undefined}>
        {(current) => (
          <ul class="list-disc pl-5 [&>li+li]:mt-1">
            <For each={current().items}>{(item) => <li>{inline(item)}</li>}</For>
          </ul>
        )}
      </Match>
      <Match when={list()?.ordered === true ? list() : undefined}>
        {(current) => (
          <ol class="list-decimal pl-5 [&>li+li]:mt-1">
            <For each={current().items}>{(item) => <li>{inline(item)}</li>}</For>
          </ol>
        )}
      </Match>
      <Match when={quote()}>
        {(current) => <blockquote class="border-l border-line-3 pl-3 text-ink-2">{inline(current().text)}</blockquote>}
      </Match>
      <Match when={paragraph()}>{(current) => <p class="whitespace-pre-wrap">{inline(current().text)}</p>}</Match>
    </Switch>
  )
}

export function Markdown(props: { text: string; small?: boolean; muted?: boolean; streaming?: boolean }): JSX.Element {
  const blocks = createMemo(() => parseBlocks(props.text, props.streaming === true))

  return (
    <div
      class="flex flex-col gap-2.5 leading-[1.6] [overflow-wrap:anywhere]"
      classList={{
        "text-base": props.small !== true,
        "text-sm": props.small === true,
        "text-ink": props.muted !== true,
        "text-ink-2": props.muted === true,
      }}
    >
      <Index each={blocks()}>
        {(block) => <Block block={createMemo<MarkdownBlock>((previous) => settle(previous, block()))} />}
      </Index>
    </div>
  )
}
