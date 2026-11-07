import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { configureRow, errorMessage, packages, rows } from "../../state/extensions.ts"
import { Button, Chip, Empty, Failure, MONO_INPUT, MissingOp, Note, Panel, Pending, Toggle } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

function indexesOf(config: Readonly<Record<string, unknown>>): readonly string[] {
  const value = config["indexes"]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

export function Sources(): JSX.Element {
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void rows.reload()
    void packages.reload()
  })

  const marketRow = () => {
    const state = rows.state()
    return state.kind === "ready" ? state.value.find((row) => row.plugin === "market") : undefined
  }

  const indexes = (): readonly string[] => {
    const row = marketRow()
    return row === undefined ? [] : indexesOf(row.config)
  }

  const save = async (next: readonly string[]): Promise<void> => {
    const row = marketRow()
    if (row === undefined || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await configureRow(row.id, { ...row.config, indexes: next })
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    const url = draft().trim()
    if (url === "" || !url.startsWith("https://") || indexes().includes(url)) return
    await save([...indexes(), url])
    setDraft("")
  }

  const installed = (): readonly { readonly package: string; readonly version: string }[] => {
    const state = packages.state()
    return state.kind === "ready" ? state.value.installed : []
  }

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex max-w-[880px] flex-col gap-6 px-8 pb-12 pt-6">
        <div>
          <span class="label">Extensions › Sources</span>
          <h2 class="mt-1.5 text-[18px] font-medium tracking-[-0.02em]">Where extensions come from</h2>
          <p class="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-fg-3">
            Discover searches every index URL that is on. Each index is one https document in the market format; packages from
            a URL or git build stay off until you enable them.
          </p>
        </div>

        <Show when={error()}>
          {(message) => <Failure message={message()} onRetry={() => setError(undefined)} />}
        </Show>

        <Show when={rows.state().kind === "loading"}>
          <Pending label="Reading the market row" />
        </Show>

        <Show when={rows.state().kind === "ready"}>
          <Show
            when={marketRow()}
            fallback={
              <Empty
                title="The market row is not in this build."
                detail="Index URLs live in the market plugin's config. Without that row there is nowhere to put a source."
              />
            }
          >
              {(row) => (
                <section class="flex flex-col gap-2.5">
                  <div class="flex items-center gap-2">
                    <span class="label">Indexes</span>
                    <span class="text-[12px] text-fg-3">
                      {indexes().length} {indexes().length === 1 ? "source" : "sources"}
                    </span>
                  </div>
                  <Panel>
                    <Show
                      when={indexes().length > 0}
                      fallback={
                        <div class="px-3.5 py-3 text-[12.5px] text-fg-3">
                          No index is configured. Discover has nothing to read until you add one.
                        </div>
                      }
                    >
                      <For each={indexes()}>
                        {(url) => (
                          <div class="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-0">
                            <span class="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg-2">
                              <Glyph name="globe" size={15} />
                            </span>
                            <div class="min-w-0 flex-1">
                              <span class="block truncate font-mono text-[11.5px] text-fg">{url}</span>
                              <span class="block text-[11.5px] text-fg-3">On · market format 1</span>
                            </div>
                            <Toggle
                              on
                              disabled={busy()}
                              label={`Remove ${url}`}
                              onChange={() => void save(indexes().filter((entry) => entry !== url))}
                            />
                          </div>
                        )}
                      </For>
                    </Show>
                    <div class="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
                      <Glyph name="plus" size={13} class="text-fg-3" />
                      <input
                        value={draft()}
                        onInput={(event) => setDraft(event.currentTarget.value)}
                        placeholder="https://index.example/v1"
                        spellcheck={false}
                        aria-label="Add index URL"
                        class={`${MONO_INPUT} h-7 border-transparent bg-transparent px-0 focus:border-transparent`}
                      />
                      <Button
                        label="Add index"
                        disabled={busy() || !draft().trim().startsWith("https://")}
                        onClick={() => void add()}
                      />
                    </div>
                  </Panel>
                  <Note>
                    Order is not editable here: the market reads indexes in the order this config lists them. Two indexes that
                    publish the same name resolve to the first one read.
                  </Note>
                  <span class="mono-meta">{row().id}</span>
                </section>
              )}
          </Show>
        </Show>

        <section class="flex flex-col gap-2.5">
          <div class="flex items-center gap-2">
            <span class="label">Install policy</span>
            <Chip tone="warn">Read-only</Chip>
          </div>
          <Panel>
            <PolicyRow icon="shield" title="Signed packages only" detail="Unsigned packages can be added from a URL or git, but stay off until enabled." value="On" />
            <PolicyRow icon="refresh" title="Auto-update" detail="Patch versions only; anything that adds a row or a permission asks first." value="Patch only" />
            <PolicyRow icon="user" title="Who can install" detail="One owner signs in; members do not exist in this build." value="Owner" />
          </Panel>
          <MissingOp op="market.policy" detail="These values are fixed in the build, not stored settings." />
        </section>

        <section class="flex flex-col gap-2.5">
          <div class="flex items-center gap-2">
            <span class="label">Compiled packages</span>
            <span class="text-[12px] text-fg-3">In the deployed image; not removable</span>
          </div>
          <Panel>
            <Show
              when={installed().length > 0}
              fallback={<div class="px-3.5 py-3 text-[12.5px] text-fg-3">No package metadata in this build.</div>}
            >
              <For each={installed()}>
                {(entry) => (
                  <div class="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-0">
                    <Glyph name="package" size={13} class="text-fg-3" />
                    <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">{entry.package}</span>
                    <span class="font-mono text-[11px] text-fg-4">{entry.version}</span>
                  </div>
                )}
              </For>
            </Show>
          </Panel>
        </section>
      </div>
    </div>
  )
}

function PolicyRow(props: { icon: "shield" | "refresh" | "user"; title: string; detail: string; value: string }): JSX.Element {
  return (
    <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 last:border-0">
      <Glyph name={props.icon} size={14} class="shrink-0 text-fg-2" />
      <div class="min-w-0 flex-1">
        <span class="block text-[12.5px] text-fg">{props.title}</span>
        <span class="block text-[11.5px] leading-snug text-fg-3">{props.detail}</span>
      </div>
      <span class="shrink-0 rounded-[2px] border border-line-inner px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2">
        {props.value}
      </span>
    </div>
  )
}
