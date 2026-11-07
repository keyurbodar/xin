import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import {
  errorMessage,
  packages,
  rows,
  setRowEnabled,
  uninstallPackage,
  type BundleSource,
  type BundleView,
  type PluginRow,
} from "../../state/extensions.ts"
import { Button, Chip, Empty, Failure, MissingOp, Note, Panel, Pending, StateChip, Toggle, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

type Membership = { readonly bundle: BundleView }

export function Installed(props: { onCustomize: (rowId: string) => void }): JSX.Element {
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void rows.reload()
    void packages.reload()
  })

  const membership = (): ReadonlyMap<string, Membership> => {
    const state = packages.state()
    const found = new Map<string, Membership>()
    if (state.kind !== "ready") return found
    for (const bundle of state.value.bundles) {
      for (const row of bundle.rows) found.set(row.id, { bundle })
    }
    return found
  }

  const list = (): readonly PluginRow[] => {
    const state = rows.state()
    if (state.kind !== "ready") return []
    const text = filter().trim().toLowerCase()
    return state.value
      .filter((row) => {
        if (text === "") return true
        return [row.id, row.plugin, row.title].some((value) => value.toLowerCase().includes(text))
      })
      .toSorted((left, right) => left.title.localeCompare(right.title))
  }

  const selectedRow = (): PluginRow | undefined => list().find((row) => row.id === selected())

  return (
    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <div class="flex h-7 w-[280px] items-center gap-2 rounded-[2px] border border-line-inner bg-surface px-2.5">
            <Glyph name="search" size={13} class="text-fg-3" />
            <input
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter installed"
              spellcheck={false}
              aria-label="Filter installed extensions"
              class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-4 focus:outline-none"
            />
          </div>
          <span class="text-[11.5px] text-fg-3">
            {list().length} {list().length === 1 ? "row" : "rows"}
          </span>
          <span class="ml-auto text-[11.5px] text-fg-3">Compiled and runtime rows share one list</span>
        </div>

        <div class="grid grid-cols-[minmax(0,1fr)_86px_110px_80px_44px] items-center gap-2 border-b border-line px-4 py-2">
          <span class="label">Extension</span>
          <span class="label">Version</span>
          <span class="label">Status</span>
          <span class="label">Layer</span>
          <span />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={rows.state().kind === "loading"}>
            <Pending label="Reading rows" />
          </Show>
          <Show when={failureOf(rows.state())}>
            {(message) => (
              <div class="p-4">
                <Failure message={message()} onRetry={() => void rows.reload()} />
              </div>
            )}
          </Show>
          <Show when={rows.state().kind === "ready"}>
            <Show
              when={list().length > 0}
              fallback={
                <div class="p-4">
                  <Empty title="No plugin rows match." detail="Clear the filter, or install a package from Discover." />
                </div>
              }
            >
              <For each={list()}>
                {(row) => (
                  <InstalledRow
                    row={row}
                    bundle={membership().get(row.id)?.bundle}
                    selected={selected() === row.id}
                    onSelect={() => setSelected(row.id)}
                    onToggle={(next) => void toggle(row.id, next)}
                  />
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={selectedRow()}>
        {(row) => (
          <RowPanel
            row={row()}
            bundle={membership().get(row().id)?.bundle}
            onClose={() => setSelected(undefined)}
            onCustomize={() => props.onCustomize(row().id)}
          />
        )}
      </Show>
    </div>
  )
}

async function toggle(id: string, next: boolean): Promise<void> {
  try {
    await setRowEnabled(id, next)
  } catch {
    /* the row remains where it was; the list reloads next time it is opened */
  }
}

function InstalledRow(props: {
  row: PluginRow
  bundle: BundleView | undefined
  selected: boolean
  onSelect: () => void
  onToggle: (next: boolean) => void
}): JSX.Element {
  const version = (): string =>
    props.bundle === undefined ? "build" : props.bundle.source.kind === "registry" ? props.bundle.source.version : "local"

  return (
    <div
      class="grid grid-cols-[minmax(0,1fr)_86px_110px_80px_44px] items-center gap-2 border-b border-line px-4 py-2.5"
      classList={{ "bg-hover": props.selected, "opacity-55": props.row.state.kind === "disabled" }}
    >
      <button type="button" onClick={props.onSelect} class="flex min-w-0 items-center gap-2.5 text-left">
        <span class="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg-2">
          <Glyph name="layers" size={15} />
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[12.5px] font-medium text-fg">{props.row.title}</span>
          <span class="block truncate text-[11.5px] text-fg-3">
            {props.row.plugin} · {props.row.id}
          </span>
        </span>
      </button>
      <span class="truncate font-mono text-[11.5px] text-fg-2">{version()}</span>
      <span>
        <StateChip state={props.row.state} />
      </span>
      <span class="truncate text-[11.5px] capitalize text-fg-3">{props.row.layer}</span>
      <span class="flex justify-end">
        <Toggle
          on={!props.row.disabled}
          label={`${props.row.disabled ? "Enable" : "Disable"} ${props.row.title}`}
          disabled={props.row.required}
          onChange={props.onToggle}
        />
      </span>
    </div>
  )
}

function RowPanel(props: {
  row: PluginRow
  bundle: BundleView | undefined
  onClose: () => void
  onCustomize: () => void
}): JSX.Element {
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const uninstall = async (): Promise<void> => {
    const bundle = props.bundle
    if (bundle === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await uninstallPackage(bundle.package)
      setConfirming(false)
      props.onClose()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside class="flex w-[460px] shrink-0 flex-col border-l border-line bg-surface">
      <header class="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg">
          <Glyph name="layers" size={18} />
        </span>
        <div class="min-w-0 flex-1">
          <span class="block truncate text-[14px] font-medium text-fg">{props.row.title}</span>
          <span class="block truncate text-[11.5px] text-fg-3">
            {props.row.plugin} · {props.bundle === undefined ? "compiled" : props.bundle.package}
          </span>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close details" class="text-fg-3 hover:text-fg">
          <Glyph name="x" size={16} />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div class="flex flex-col gap-5">
          <div class="flex flex-wrap items-center gap-2">
            <StateChip state={props.row.state} />
            <Chip>{props.row.layer}</Chip>
            <Show when={props.row.required}>
              <Chip>Required</Chip>
            </Show>
          </div>

          <Show when={props.row.state.kind === "failed"}>
            <Failure message={props.row.state.error ?? "The row failed to start"} />
          </Show>

          <section>
            <span class="label mb-2 block">Configuration</span>
            <Panel>
              <pre class="max-h-[220px] overflow-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-2">
                {JSON.stringify(props.row.config, null, 2)}
              </pre>
            </Panel>
          </section>

          <Show when={props.bundle}>
            {(bundle) => (
              <section>
                <span class="label mb-2 block">Bundle</span>
                <Panel>
                  <div class="flex items-center justify-between border-b border-line px-3 py-2 text-[12px] last:border-0">
                    <span class="text-fg-3">Package</span>
                    <span class="font-mono text-[11.5px] text-fg-2">{bundle().package}</span>
                  </div>
                  <div class="flex items-center justify-between border-b border-line px-3 py-2 text-[12px] last:border-0">
                    <span class="text-fg-3">Source</span>
                    <span class="font-mono text-[11.5px] text-fg-2">
                      {sourceLabel(bundle().source)}
                    </span>
                  </div>
                  <div class="flex items-center justify-between px-3 py-2 text-[12px]">
                    <span class="text-fg-3">Rows</span>
                    <span class="font-mono text-[11.5px] text-fg-2">{bundle().rows.length}</span>
                  </div>
                </Panel>
              </section>
            )}
          </Show>

          <Show when={props.bundle === undefined}>
            <Note>This row is compiled into the build. Disable it here or change its config; it cannot be uninstalled.</Note>
          </Show>

          <section>
            <span class="label mb-2 block">Rollback</span>
            <div class="flex items-center gap-2">
              <Button label="Roll back to the previous version" variant="ghost" disabled />
            </div>
            <div class="mt-1.5">
              <MissingOp op="market.rollback" detail="Only forward updates are recorded today." />
            </div>
          </section>

          <Show when={error()}>
            {(message) => <Failure message={message()} />}
          </Show>
        </div>
      </div>

      <footer class="flex items-center gap-2 border-t border-line px-4 py-3">
        <Button label="Configure" icon="sliders" onClick={props.onCustomize} />
        <span class="ml-auto" />
        <Show
          when={props.bundle !== undefined}
          fallback={<span class="text-[11.5px] text-fg-4">Compiled in</span>}
        >
          <Show
            when={confirming()}
            fallback={<Button label="Uninstall" icon="trash" variant="danger" onClick={() => setConfirming(true)} />}
          >
            <Button label="Keep" variant="ghost" onClick={() => setConfirming(false)} />
            <Button
              label={busy() ? "Removing" : "Remove package"}
              variant="danger"
              disabled={busy()}
              onClick={() => void uninstall()}
            />
          </Show>
        </Show>
      </footer>
    </aside>
  )
}

function sourceLabel(source: BundleSource): string {
  return source.kind === "registry" ? `registry ${source.version}` : "local"
}
