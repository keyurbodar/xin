import { createEffect, createSignal, For, onMount, Show, Switch, Match, type JSX } from "solid-js"
import { catalog, presets, rows, servers, skills } from "../../state/extensions.ts"
import { Note } from "./chrome.tsx"
import { Glyph, type GlyphName } from "./glyph.tsx"
import { Connectors } from "./customize-connectors.tsx"
import { Skills } from "./customize-skills.tsx"
import { Presets, Prompts } from "./customize-presets.tsx"
import { Advanced } from "./customize-advanced.tsx"

type Section = "connectors" | "skills" | "prompts" | "presets" | "advanced"

const SECTIONS: readonly { readonly id: Section; readonly label: string; readonly icon: GlyphName }[] = [
  { id: "connectors", label: "Connectors", icon: "plug" },
  { id: "skills", label: "Skills", icon: "book-open" },
  { id: "prompts", label: "Prompts", icon: "scroll-text" },
  { id: "presets", label: "Presets", icon: "layers" },
  { id: "advanced", label: "Advanced", icon: "sliders" },
]

export function Customize(props: { initialRowId?: string | undefined }): JSX.Element {
  const [section, setSection] = createSignal<Section>(props.initialRowId === undefined ? "connectors" : "advanced")

  createEffect(() => {
    if (props.initialRowId !== undefined) setSection("advanced")
  })

  onMount(() => {
    void catalog.reload()
    void rows.reload()
    void servers.reload()
    void skills.reload()
    void presets.reload()
  })

  const countOf = (id: Section): number | undefined => {
    switch (id) {
      case "connectors": {
        const state = servers.state()
        return state.kind === "ready" ? state.value.length : undefined
      }
      case "skills": {
        const state = skills.state()
        return state.kind === "ready" ? state.value.length : undefined
      }
      case "prompts":
        return 0
      case "presets": {
        const state = presets.state()
        return state.kind === "ready" ? state.value.presets.length : undefined
      }
      case "advanced": {
        const state = rows.state()
        return state.kind === "ready" ? state.value.length : undefined
      }
    }
  }

  return (
    <div class="flex min-h-0 flex-1">
      <nav class="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-line px-2 py-3">
        <For each={SECTIONS}>
          {(entry) => (
            <button
              type="button"
              onClick={() => setSection(entry.id)}
              class="flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-[13.5px]"
              classList={{ "bg-selected text-fg": section() === entry.id, "text-fg-2 hover:bg-hover": section() !== entry.id }}
            >
              <Glyph name={entry.icon} size={14} class="text-fg-3" />
              {entry.label}
              <Show when={countOf(entry.id) !== undefined}>
                <span class="ml-auto font-mono text-[11px] text-fg-4">{countOf(entry.id)}</span>
              </Show>
            </button>
          )}
        </For>
        <div class="my-2 h-px bg-line" />
        <Note>Package skills are read-only. Forking a skill copies it into the owner's own set.</Note>
      </nav>

      <Switch>
        <Match when={section() === "connectors"}>
          <Connectors />
        </Match>
        <Match when={section() === "skills"}>
          <Skills />
        </Match>
        <Match when={section() === "prompts"}>
          <Prompts />
        </Match>
        <Match when={section() === "presets"}>
          <Presets />
        </Match>
        <Match when={section() === "advanced"}>
          <Advanced initialRowId={props.initialRowId} />
        </Match>
      </Switch>
    </div>
  )
}

