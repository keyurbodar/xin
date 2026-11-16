import "@ui-sdk/web/collapsible"
import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { navigate } from "../../lib/router.ts"
import {
  catalog,
  errorMessage,
  rows,
  setRowEnabled,
  type CatalogEntry,
  type PluginRow,
} from "../../state/extensions.ts"
import { Button, Failure, Note, Pending, StateChip, failureOf } from "../extensions/chrome.tsx"
import { ConfigForm } from "../extensions/config-form.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Card, Group, Switch } from "./parts.tsx"

export function Plugins(): JSX.Element {
  const [filter, setFilter] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void rows.reload()
    void catalog.reload()
  })

  const all = (): readonly PluginRow[] => {
    const state = rows.state()
    return state.kind === "ready" ? state.value.toSorted((left, right) => left.title.localeCompare(right.title)) : []
  }

  const entryFor = (plugin: string): CatalogEntry | undefined => {
    const state = catalog.state()
    return state.kind === "ready" ? state.value.find((entry) => entry.name === plugin) : undefined
  }

  const shown = (): readonly PluginRow[] => {
    const text = filter().trim().toLowerCase()
    if (text === "") return all()
    return all().filter((row) =>
      [row.title, row.id, row.plugin, entryFor(row.plugin)?.description ?? ""].some((value) =>
        value.toLowerCase().includes(text),
      ),
    )
  }

  const byId = (): ReadonlyMap<string, PluginRow> => new Map(all().map((row) => [row.id, row]))

  const optional = (): readonly PluginRow[] => shown().filter((row) => !row.required)
  const core = (): readonly PluginRow[] => shown().filter((row) => row.required)

  const tally = (kind: "active" | "disabled" | "broken"): number =>
    all().filter((row) =>
      kind === "broken" ? row.state.kind === "failed" || row.state.kind === "missing" : row.state.kind === kind,
    ).length

  const toggle = async (row: PluginRow, next: boolean): Promise<void> => {
    setError(undefined)
    try {
      await setRowEnabled(row.id, next)
    } catch (failure: unknown) {
      setError(`${row.title}: ${errorMessage(failure)}`)
    }
  }

  return (
    <>
      <div class="grid grid-cols-3 overflow-hidden rounded-lg shadow-ring">
        <Figure label="Running" value={tally("active")} />
        <Figure label="Off" value={tally("disabled")} />
        <Figure label="Not running" value={tally("broken")} bad={tally("broken") > 0} />
      </div>

      <div class="flex items-center gap-2">
        <ui-input-group class="flex h-[var(--h-control)] min-w-0 flex-1 items-center gap-2 rounded-sm bg-bg px-2 shadow-ring focus-within:shadow-[0_0_0_1px_var(--color-primary),0_0_0_3px_var(--color-primary-soft)]">
          <Glyph name="search" size={14} class="text-ink-3" />
          <ui-input class="flex min-w-0 flex-1">
            <input
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter plugins"
              spellcheck={false}
              aria-label="Filter plugins"
              class="min-w-0 flex-1 bg-transparent text-small text-ink outline-none placeholder:text-placeholder"
            />
          </ui-input>
        </ui-input-group>
        <Button size="sm" class="im-press" onClick={() => navigate("/extensions/installed")}>
          <Glyph name="package" size={14} />
          Packages
        </Button>
      </div>

      <Show when={error()}>{(message) => <Failure message={message()} />}</Show>
      <Show when={rows.state().kind === "loading"}>
        <Pending label="Reading plugin rows" />
      </Show>
      <Show when={failureOf(rows.state())}>
        {(message) => <Failure message={message()} onRetry={() => void rows.reload()} />}
      </Show>

      <Show when={rows.state().kind === "ready"}>
        <Show
          when={shown().length > 0}
          fallback={<p class="py-6 text-center text-small text-ink-3">No plugin matches “{filter().trim()}”.</p>}
        >
          <Show when={optional().length > 0}>
            <Group title="Optional" detail="A row that is off doesn’t start, so its tools and ops are gone until it’s on">
              <Card>
                <For each={optional().map((row) => row.id)}>
                  {(id) => (
                    <Show when={byId().get(id)}>
                      {(row) => (
                        <PluginLine
                          row={row()}
                          entry={entryFor(row().plugin)}
                          onToggle={(next) => void toggle(row(), next)}
                        />
                      )}
                    </Show>
                  )}
                </For>
              </Card>
            </Group>
          </Show>
          <Show when={core().length > 0}>
            <Group title="Core" detail="The kernel needs these to run; they can’t be turned off">
              <Card>
                <For each={core().map((row) => row.id)}>
                  {(id) => (
                    <Show when={byId().get(id)}>{(row) => <PluginLine row={row()} entry={entryFor(row().plugin)} />}</Show>
                  )}
                </For>
              </Card>
            </Group>
          </Show>
        </Show>
      </Show>

      <Note>
        Switches write one plugin row each and apply at once. Install, update, roll back or remove packages from
        Extensions.
      </Note>
    </>
  )
}

function Figure(props: { label: string; value: number; bad?: boolean | undefined }): JSX.Element {
  return (
    <div class="border-r border-line-1 px-4 py-3 last:border-r-0">
      <span class="block text-mini text-ink-3">{props.label}</span>
      <span
        class="mt-0.5 block font-mono text-title-sm tabular-nums"
        classList={{ "text-failed": props.bad === true, "text-ink": props.bad !== true }}
      >
        {props.value}
      </span>
    </div>
  )
}

function PluginLine(props: {
  row: PluginRow
  entry: CatalogEntry | undefined
  onToggle?: ((next: boolean) => void) | undefined
}): JSX.Element {
  const [mounted, setMounted] = createSignal(false)
  const [open, setOpen] = createSignal(false)

  const configurable = (): boolean => props.entry?.schema !== null && props.entry?.schema !== undefined

  return (
    <ui-collapsible
      class="block"
      on:openchange={(event) => {
        setOpen(event.detail.value)
        if (event.detail.value) setMounted(true)
      }}
    >
      <div class="flex items-start gap-3 px-4 py-3" classList={{ "opacity-60": props.row.state.kind === "disabled" }}>
        <span class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-ink-2 shadow-ring">
          <Glyph name="plug" size={14} />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-small font-title text-ink">{props.row.title}</span>
            <StateChip state={props.row.state} />
          </div>
          <Show when={props.entry?.description}>
            {(description) => <span class="mt-0.5 block text-mini text-ink-3">{description()}</span>}
          </Show>
          <span class="mt-1 block truncate font-mono text-micro text-icon">{props.row.id}</span>
          <Show when={props.row.state.kind === "failed" ? props.row.state.error : undefined}>
            {(message) => <span class="mt-1 block text-mini text-failed">{message()}</span>}
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-2 pt-0.5">
          <Show when={configurable()}>
            <ui-collapsible-trigger>
              <button
                type="button"
                class="im-press im-hover inline-flex h-[var(--h-control-sm)] items-center gap-1 rounded-sm px-2 text-small text-ink-2"
              >
                Configure
                <span class="im-chevron inline-flex" data-open={open() ? "" : undefined}>
                  <Glyph name="chevron-right" size={14} />
                </span>
              </button>
            </ui-collapsible-trigger>
          </Show>
          <Show when={props.onToggle}>
            {(onToggle) => (
              <Switch
                on={!props.row.disabled}
                label={`${props.row.disabled ? "Turn on" : "Turn off"} ${props.row.title}`}
                onChange={onToggle()}
              />
            )}
          </Show>
        </div>
      </div>
      <Show when={configurable()}>
        <ui-collapsible-panel class="im-grow">
          <div>
            <div class="border-t border-line-1 px-4 py-3.5 pl-[56px]">
              <Show when={mounted() && props.entry}>
                {(entry) => <ConfigForm rowId={props.row.id} schema={entry().schema} config={props.row.config} />}
              </Show>
            </div>
          </div>
        </ui-collapsible-panel>
      </Show>
    </ui-collapsible>
  )
}
