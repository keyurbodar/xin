import { createSignal, For, Show, type JSX } from "solid-js"
import { catalog, rows, setRowEnabled, type CatalogEntry, type PluginRow } from "../../state/extensions.ts"
import { Chip, Empty, Failure, Note, Panel, Pending, StateChip, Toggle, failureOf } from "./chrome.tsx"
import { ConfigForm } from "./config-form.tsx"

export function Advanced(props: { initialRowId?: string | undefined }): JSX.Element {
  const [selected, setSelected] = createSignal<string | undefined>(props.initialRowId)

  const list = (): readonly PluginRow[] => {
    const state = rows.state()
    return state.kind === "ready" ? state.value.toSorted((left, right) => left.id.localeCompare(right.id)) : []
  }

  const current = (): PluginRow | undefined => list().find((row) => row.id === selected())

  const entryFor = (plugin: string): CatalogEntry | undefined => {
    const state = catalog.state()
    return state.kind === "ready" ? state.value.find((entry) => entry.name === plugin) : undefined
  }

  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">Plugin rows</span>
          <span class="ml-auto text-[11.5px] text-fg-3">{list().length}</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={rows.state().kind === "loading"}>
            <Pending label="Reading rows" />
          </Show>
          <Show when={failureOf(rows.state())}>
            {(message) => (
              <div class="p-3">
                <Failure message={message()} onRetry={() => void rows.reload()} />
              </div>
            )}
          </Show>
          <For each={list()}>
            {(row) => (
              <button
                type="button"
                onClick={() => setSelected(row.id)}
                class="flex w-full items-center gap-2.5 border-b border-line px-3.5 py-2.5 text-left transition-none hover:bg-hover"
                classList={{ "bg-hover": selected() === row.id }}
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] font-medium text-fg">{row.title}</span>
                  <span class="block truncate font-mono text-[10.5px] text-fg-3">
                    {row.id} · {row.plugin}
                  </span>
                </span>
                <StateChip state={row.state} />
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={current()}
          fallback={
            <div class="px-6 py-6">
              <Empty
                title="Pick a plugin row."
                detail="Every row in this build is listed here: hooks, local builds and the raw config behind each one."
              />
            </div>
          }
        >
          {(row) => (
            <>
              <header class="flex items-center gap-3 border-b border-line px-6 py-4">
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-[16px] font-medium text-fg">{row().title}</span>
                  <span class="block truncate text-[12px] text-fg-3">
                    {row().plugin} · {row().layer} · <span class="font-mono">{row().id}</span>
                  </span>
                </div>
                <Show when={row().required}>
                  <Chip>Required</Chip>
                </Show>
                <Toggle
                  on={!row().disabled}
                  label={`${row().disabled ? "Enable" : "Disable"} ${row().title}`}
                  disabled={row().required}
                  onChange={(next) => void setRowEnabled(row().id, next)}
                />
              </header>
              <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div class="max-w-[640px]">
                  <Show when={row().state.kind === "failed"}>
                    <div class="mb-4">
                      <Failure message={row().state.error ?? "The row failed"} />
                    </div>
                  </Show>
                  <Show
                    when={entryFor(row().plugin)}
                    fallback={
                      <div class="flex flex-col gap-3">
                        <Note>
                          This plugin has no catalog entry in this build, so its config schema is not known. The raw config is
                          shown read-only.
                        </Note>
                        <Panel>
                          <pre class="max-h-[320px] overflow-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-2">
                            {JSON.stringify(row().config, null, 2)}
                          </pre>
                        </Panel>
                      </div>
                    }
                  >
                    {(entry) => (
                      <Show
                        when={entry().schema !== null && entry().schema !== undefined}
                        fallback={
                          <div class="flex flex-col gap-3">
                            <Note>This plugin declares no config schema. Its row config is shown read-only.</Note>
                            <Panel>
                              <pre class="max-h-[320px] overflow-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-2">
                                {JSON.stringify(row().config, null, 2)}
                              </pre>
                            </Panel>
                          </div>
                        }
                      >
                        <ConfigForm
                          rowId={row().id}
                          schema={entry().schema}
                          config={row().config}
                          onSaved={() => void rows.reload()}
                        />
                      </Show>
                    )}
                  </Show>
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  )
}
