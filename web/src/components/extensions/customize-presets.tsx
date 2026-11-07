import { createSignal, For, Show, type JSX } from "solid-js"
import { presets } from "../../state/extensions.ts"
import { Chip, Empty, Failure, MissingOp, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

export function Prompts(): JSX.Element {
  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">Prompts</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="p-3">
            <Empty title="No prompt ops in this build." detail="Slash commands would live here; the backend exposes no prompt rows yet.">
              <MissingOp op="prompt.list" />
            </Empty>
          </div>
        </div>
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="px-6 py-6">
          <Note>
            Prompts are planned as read-only rows contributed by packages, plus owner-written slash commands. Until the op
            exists, nothing here can list or edit them.
          </Note>
        </div>
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- presets */

function toolsOf(preset: { readonly tools: "all" | readonly string[] }): readonly string[] {
  return preset.tools === "all" ? [] : preset.tools
}

export function Presets(): JSX.Element {
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const list = () => {
    const state = presets.state()
    return state.kind === "ready" ? state.value : []
  }
  const current = () => list().find((preset) => preset.id === selected())

  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">Presets</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={presets.state().kind === "loading"}>
            <Pending label="Reading presets" />
          </Show>
          <Show when={failureOf(presets.state())}>
            {(message) => (
              <div class="p-3">
                <Failure message={message()} onRetry={() => void presets.reload()} />
              </div>
            )}
          </Show>
          <For each={list()}>
            {(preset) => (
              <button
                type="button"
                onClick={() => setSelected(preset.id)}
                class="flex w-full items-start gap-2.5 border-b border-line px-3.5 py-3 text-left transition-none hover:bg-hover"
                classList={{ "bg-hover": selected() === preset.id }}
              >
                <Glyph name="layers" size={15} class="mt-0.5 shrink-0 text-fg-3" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[12.5px] font-medium text-fg">{preset.name}</span>
                    <Show when={preset.isDefault}>
                      <Chip>Default</Chip>
                    </Show>
                  </span>
                  <span class="line-clamp-2 block text-[11.5px] leading-snug text-fg-3">
                    {preset.description ?? (preset.tools === "all" ? "Every tool row." : `${preset.tools.length} tools`)}
                  </span>
                </span>
              </button>
            )}
          </For>
          <Show when={presets.state().kind === "ready" && list().length === 0}>
            <div class="p-3">
              <Empty title="No presets." detail="Presets bundle tool access for a thread." />
            </div>
          </Show>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={current()}
          fallback={
            <div class="px-6 py-6">
              <Empty title="Pick a preset." detail="A thread cannot raise its own preset; the composer chip chooses one per message." />
            </div>
          }
        >
          {(preset) => (
            <>
              <header class="flex items-center gap-3 border-b border-line px-6 py-4">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg">
                  <Glyph name="layers" size={18} />
                </span>
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-[16px] font-medium text-fg">{preset().name}</span>
                  <span class="mono-meta block">{preset().id}</span>
                </div>
                <Show when={preset().isDefault}>
                  <Chip>Default for new threads</Chip>
                </Show>
              </header>
              <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div class="flex max-w-[520px] flex-col gap-4">
                  <Show when={preset().description}>
                    {(description) => <p class="text-[13px] leading-relaxed text-fg-2">{description()}</p>}
                  </Show>
                  <Panel>
                    <div class="border-b border-line px-3.5 py-2.5">
                      <span class="label">Tools</span>
                    </div>
                    <div class="px-3.5 py-3">
                      <Show
                        when={preset().tools !== "all"}
                        fallback={<span class="text-[12.5px] text-fg-2">Every tool row.</span>}
                      >
                        <div class="flex flex-wrap gap-1.5">
                          <For each={toolsOf(preset())}>
                            {(tool) => <Chip>{tool}</Chip>}
                          </For>
                        </div>
                      </Show>                    </div>
                  </Panel>
                  <Note>
                    The preset is picked per thread in the composer. Selecting one for a conversation goes through
                    preset.select, which needs a conversation id this screen does not own.
                  </Note>
                  <MissingOp op="preset.edit" detail="Presets are contributed by plugin rows; edit them in Advanced." />
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  )
}

