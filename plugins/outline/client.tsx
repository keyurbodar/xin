import {
  definePlugin,
  entryBatchRows,
  entryText,
  entryToolCalls,
  type EntryView,
  type PaneConversation,
  type RenderedCall,
} from "@ingle/sdk"
import { For, Show, type JSX } from "solid-js"

type Mark = { readonly key: string; readonly entryId: number; readonly kind: "you" | "tool"; readonly label: string }

function marksOf(entry: EntryView): readonly Mark[] {
  switch (entry.kind) {
    case "pi.user": {
      const text = entryText(entry)
      return text === "" ? [] : [{ key: `${entry.id}`, entryId: entry.id, kind: "you", label: text }]
    }
    case "xin.batch":
      return entryBatchRows(entry).flatMap((row, index) =>
        row.kind === "user" && row.text.trim() !== ""
          ? [{ key: `${entry.id}:${index}`, entryId: entry.id, kind: "you" as const, label: row.text }]
          : [],
      )
    case "pi.assistant":
      return entryToolCalls(entry).map((call, index) => ({
        key: `${entry.id}:${call.id ?? index}`,
        entryId: entry.id,
        kind: "tool" as const,
        label: call.name,
      }))
    default:
      return []
  }
}

function jump(entryId: number): void {
  const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-entry]"))
  const target = anchors.find((anchor) => Number(anchor.dataset.entry) >= entryId) ?? anchors.at(-1)
  const box = target?.firstElementChild ?? target
  box?.scrollIntoView({ behavior: "smooth", block: "start" })
}

function Outline(props: { conversation: PaneConversation | undefined }): JSX.Element {
  const marks = (): readonly Mark[] => props.conversation?.entries.flatMap(marksOf) ?? []
  return (
    <Show
      when={marks().length > 0}
      fallback={<div class="px-4 py-6 text-center text-sm text-ink-3">Nothing to outline yet.</div>}
    >
      <ol class="flex flex-col py-2">
        <For each={marks()}>
          {(mark) => (
            <li>
              <button
                type="button"
                onClick={() => jump(mark.entryId)}
                class="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-secondary"
              >
                <span class="w-9 shrink-0 font-mono text-2xs text-icon">{mark.kind}</span>
                <span
                  class="min-w-0 flex-1 truncate"
                  classList={{ "text-ink-2": mark.kind === "you", "font-mono text-ink-3": mark.kind === "tool" }}
                >
                  {mark.label}
                </span>
              </button>
            </li>
          )}
        </For>
      </ol>
    </Show>
  )
}

function HelloCard(props: { call: RenderedCall }): JSX.Element {
  const who = (): string => (typeof props.call.args.who === "string" ? props.call.args.who : "someone")
  return (
    <div class="flex items-center gap-2.5 rounded-md border border-line-2 bg-card px-3 py-2 text-sm">
      <span class="font-mono text-2xs text-icon">hello</span>
      <span class="text-ink-2">{props.call.output ?? `Greeting ${who()}…`}</span>
      <Show when={props.call.status === "error"}>
        <span class="ml-auto text-failed">failed</span>
      </Show>
    </div>
  )
}

export default definePlugin({
  name: "outline",
  slots: {
    "pane.tab": [{ id: "outline", title: "Outline", component: Outline, order: 10 }],
    "message.renderer": [{ tool: "hello", component: HelloCard }],
  },
})
