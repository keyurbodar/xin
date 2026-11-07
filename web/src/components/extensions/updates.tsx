import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import {
  errorMessage,
  market,
  marketDetail,
  offeredVersion,
  rows,
  updateFromMarket,
  type MarketDetail,
  type MarketSummary,
} from "../../state/extensions.ts"
import { ago } from "../../lib/format.ts"
import { Button, Empty, Failure, MissingOp, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

export function Updates(): JSX.Element {
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [note, setNote] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void market.reload()
    void rows.reload()
  })

  const available = (): readonly MarketSummary[] => {
    const state = market.state()
    if (state.kind !== "ready") return []
    return state.value.filter((entry) => entry.status === "update-available")
  }

  const updateOne = async (entry: MarketSummary): Promise<void> => {
    setError(undefined)
    setNote(undefined)
    setBusy(entry.name)
    try {
      const detail = marketDetail(entry.name)
      await detail.reload()
      const state = detail.state()
      const offered = state.kind === "ready" ? offeredVersion(state.value) : undefined
      if (offered === undefined) throw new Error(`${entry.name} offers no compatible version`)
      const result = await updateFromMarket(entry.name, offered.version)
      setNote(
        result.application === "applied"
          ? `${entry.name} updated to ${offered.version}`
          : `${entry.name} recorded for the next update`,
      )
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const updateAll = async (): Promise<void> => {
    for (const entry of available()) await updateOne(entry)
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pb-12 pt-6">
      <div class="flex items-center gap-2.5">
        <span class="label">Updates</span>
        <span class="text-[12px] text-fg-3">
          {available().length} {available().length === 1 ? "package offers" : "packages offer"} a newer version
        </span>
        <span class="ml-auto" />
        <Button
          label={busy() === undefined ? `Update all (${available().length})` : "Updating"}
          icon="refresh"
          disabled={busy() !== undefined || available().length === 0}
          onClick={() => void updateAll()}
        />
      </div>

      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>
      <Show when={note()}>
        {(message) => (
          <div class="flex items-center gap-2 rounded-[4px] border border-ok/30 bg-ok-bg px-3.5 py-2.5 text-[12.5px] text-fg-2">
            <Glyph name="check" size={13} class="text-ok" />
            {message()}
          </div>
        )}
      </Show>

      <Show when={market.state().kind === "loading"}>
        <Pending label="Checking the market" />
      </Show>
      <Show when={failureOf(market.state())}>
        {(message) => <Failure message={message()} onRetry={() => void market.reload()} />}
      </Show>

      <Show when={market.state().kind === "ready"}>
        <Show
          when={available().length > 0}
          fallback={
            <Empty
              title="Everything is current."
              detail="Updates appear here when an index offers a newer version for this build. Auto-update is not part of this build yet."
            >
              <MissingOp op="market.auto-update" detail="Every update needs an explicit press." />
            </Empty>
          }
        >
          <Panel>
            <For each={available()}>
              {(entry) => (
                <UpdateRow entry={entry} busy={busy() === entry.name} disabled={busy() !== undefined} onUpdate={() => void updateOne(entry)} />
              )}
            </For>
          </Panel>
        </Show>
      </Show>

      <Show when={available().length > 0}>
        <Note>
          Threads finish on the running version first. An update that adds a row or changes a config asks here before it applies.
        </Note>
      </Show>
    </div>
  )
}

function UpdateRow(props: { entry: MarketSummary; busy: boolean; disabled: boolean; onUpdate: () => void }): JSX.Element {
  const detail = marketDetail(props.entry.name)
  const [open, setOpen] = createSignal(false)

  onMount(() => {
    void detail.reload()
  })

  const value = (): MarketDetail | undefined => {
    const state = detail.state()
    return state.kind === "ready" ? state.value : undefined
  }

  const version = (): string => offeredVersion(value())?.version ?? "—"

  const currentRows = (): readonly string[] => {
    const state = rows.state()
    return state.kind === "ready" ? state.value.map((row) => row.id) : []
  }

  const added = (): readonly string[] =>
    (value()?.rows ?? []).filter((row) => !currentRows().includes(row.id)).map((row) => row.id)

  return (
    <div class="border-b border-line last:border-0">
      <div class="flex items-center gap-3 px-3.5 py-3">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg-2">
          <Glyph name="package" size={16} />
        </span>
        <button type="button" onClick={() => setOpen((value) => !value)} class="min-w-0 flex-1 text-left">
          <span class="block truncate text-[12.5px] font-medium text-fg">{props.entry.title}</span>
          <span class="block truncate text-[11.5px] text-fg-3">
            {props.entry.name}
            <Show when={props.entry.author}>
              {(author) => <span> · {author()}</span>}
            </Show>
          </span>
        </button>
        <span class="font-mono text-[12px] text-accent-text">{version()}</span>
        <Button
          label={props.busy ? "Updating" : "Review + update"}
          variant="primary"
          disabled={props.disabled}
          onClick={() => {
            setOpen(true)
            props.onUpdate()
          }}
        />
      </div>

      <Show when={open()}>
        <div class="flex flex-col gap-4 border-t border-line bg-page px-3.5 py-4">
          <Show when={failureOf(detail.state())}>
            {(message) => <Failure message={message()} onRetry={() => void detail.reload()} />}
          </Show>
          <Show when={value()}>
            {(entry) => (
              <>
                <div class="flex items-center gap-2.5">
                  <span class="font-mono text-[12px] text-fg-3">current</span>
                  <Glyph name="arrow-right" size={13} class="text-fg-4" />
                  <span class="font-mono text-[12px] text-fg">{version()}</span>
                  <Show when={offeredVersion(entry())?.publishTimestamp}>
                    {(at) => <span class="ml-auto text-[11.5px] text-fg-3">{ago(at())}</span>}
                  </Show>
                </div>

                <div>
                  <span class="label mb-2 block">What changes</span>
                  <Panel>
                    <For each={added()}>
                      {(id) => (
                        <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12.5px] last:border-0">
                          <span class="font-mono text-[12px] text-ok">+</span>
                          <code class="font-mono text-[11.5px] text-fg">{id}</code>
                          <span class="text-[11.5px] text-fg-3">new row</span>
                        </div>
                      )}
                    </For>
                    <For each={entry().requires}>
                      {(spec) => (
                        <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12.5px] last:border-0">
                          <span class="font-mono text-[12px] text-warn">+</span>
                          <code class="font-mono text-[11.5px] text-fg">{spec}</code>
                          <span class="text-[11.5px] text-fg-3">requirement</span>
                        </div>
                      )}
                    </For>
                    <Show when={added().length === 0 && entry().requires.length === 0}>
                      <div class="px-3 py-2 text-[12px] text-fg-3">No new rows or requirements. Config stays as it is.</div>
                    </Show>
                  </Panel>
                </div>

                <div class="flex items-center gap-2">
                  <Button label="Skip this version" variant="ghost" disabled />
                  <MissingOp op="market.skip" />
                  <span class="ml-auto" />
                  <Show when={offeredVersion(entry())}>
                    {(version) => (
                      <span class="text-[11.5px] text-fg-3">Targets v{version().version}</span>
                    )}
                  </Show>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
