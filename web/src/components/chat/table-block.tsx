import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { CopyButton } from "./code-block.tsx"
import { Fullscreen, FullscreenButton } from "./expandable.tsx"
import { inline } from "./inline.tsx"
import type { Align } from "./markdown-parse.ts"
import type { BlockPayloads } from "./registry.ts"
import { tableCsv, tableMarkdown } from "./table-copy.ts"

const COLLAPSE_AT = 12
const SHOWN = 10

const ALIGN: Record<Align, string> = { left: "text-left", center: "text-center", right: "text-right tabular-nums" }

function Grid(props: { header: readonly string[]; align: readonly Align[]; rows: readonly (readonly string[])[] }): JSX.Element {
  const side = (column: number): string => ALIGN[props.align[column] ?? "left"]
  return (
    <table class="w-max min-w-full border-collapse text-base leading-[1.5]">
      <thead>
        <tr>
          <For each={props.header}>
            {(cell, column) => (
              <th
                class={`sticky top-0 z-[1] bg-panel px-3 py-1.5 text-2xs font-normal tracking-wide whitespace-nowrap text-ink-3 uppercase shadow-[inset_0_-1px_0_var(--color-line-1)] ${side(column())}`}
              >
                {inline(cell)}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr>
              <For each={row}>
                {(cell, column) => (
                  <td class={`border-b border-line-2 px-3 py-1.5 align-top text-ink-2 ${side(column())}`}>{inline(cell)}</td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

export function TableBlock(props: BlockPayloads["table"]): JSX.Element {
  const [all, setAll] = createSignal(false)
  const [full, setFull] = createSignal(false)
  const [edges, setEdges] = createSignal({ left: false, right: false })
  let scroller!: HTMLDivElement

  const long = (): boolean => props.rows.length > COLLAPSE_AT
  const rows = (): string[][] => (long() && !all() ? props.rows.slice(0, SHOWN) : props.rows)

  const measure = (): void => {
    const left = scroller.scrollLeft > 1
    const right = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
    const current = edges()
    if (current.left !== left || current.right !== right) setEdges({ left, right })
  }

  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    const table = scroller.firstElementChild
    if (table !== null) observer.observe(table)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div class="group relative rounded-md border border-line-2 bg-panel" data-block="table">
      <div class="absolute top-1 right-1 z-[2] flex items-center gap-0.5 rounded-sm bg-card font-mono text-2xs text-ink-3 opacity-0 shadow-ring transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <CopyButton
          text={() => tableMarkdown(props.header, props.align, props.rows)}
          label="Copy table as Markdown"
          idle="Markdown"
        />
        <CopyButton text={() => tableCsv(props.header, props.rows)} label="Copy table as CSV" idle="CSV" />
        <FullscreenButton label="Open table full screen" onClick={() => setFull(true)} />
      </div>
      <div class="relative overflow-hidden rounded-t-md" classList={{ "rounded-b-md": !long() }}>
        <div ref={scroller} onScroll={measure} class="max-h-[480px] overflow-auto overscroll-x-contain">
          <Grid header={props.header} align={props.align} rows={rows()} />
        </div>
        <Show when={edges().left}>
          <div class="pointer-events-none absolute inset-y-0 left-0 z-[2] w-8 bg-linear-to-r from-panel to-transparent" />
        </Show>
        <Show when={edges().right}>
          <div class="pointer-events-none absolute inset-y-0 right-0 z-[2] w-8 bg-linear-to-l from-panel to-transparent" />
        </Show>
      </div>
      <Show when={long()}>
        <button
          type="button"
          aria-expanded={all()}
          onClick={() => setAll((on) => !on)}
          class="im-press flex h-8 w-full items-center justify-center font-mono text-2xs text-ink-3 hover:text-ink"
        >
          {all() ? "Show fewer rows" : `Show all ${props.rows.length} rows`}
        </button>
      </Show>
      <Fullscreen open={full()} onClose={() => setFull(false)} title={`Table · ${props.rows.length} rows`}>
        <Grid header={props.header} align={props.align} rows={props.rows} />
      </Fullscreen>
    </div>
  )
}
