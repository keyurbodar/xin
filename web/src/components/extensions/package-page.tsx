import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import {
  market,
  marketDetail,
  offeredVersion,
  rows,
  type MarketDetail,
  type MarketSummary,
} from "../../state/extensions.ts"
import { ago } from "../../lib/format.ts"
import { Button, Chip, Failure, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"
import { InstallSheet } from "./install-sheet.tsx"

type Tab = "overview" | "permissions" | "versions" | "source"

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "permissions", label: "Mounts" },
  { id: "versions", label: "Versions" },
  { id: "source", label: "Source" },
]

export function PackagePage(props: {
  name: string
  onBack: () => void
  onCustomize: () => void
}): JSX.Element {
  const detail = marketDetail(props.name)
  const [tab, setTab] = createSignal<Tab>("overview")
  const [sheet, setSheet] = createSignal(false)

  onMount(() => {
    void detail.reload()
    void market.reload()
    void rows.reload()
  })

  const summary = (): MarketSummary | undefined => {
    const state = market.state()
    return state.kind === "ready" ? state.value.find((entry) => entry.name === props.name) : undefined
  }

  const value = (): MarketDetail | undefined => {
    const state = detail.state()
    return state.kind === "ready" ? state.value : undefined
  }

  const latest = (): string | undefined => offeredVersion(value())?.version
  const requires = (): string => {
    const detail = value()
    if (detail === undefined || detail.requires.length === 0) return "Nothing extra"
    return `${detail.requires.length} packages`
  }

  const installed = (): boolean => {
    const status = value()?.status
    return status === "installed" || status === "different-version"
  }

  return (
    <>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="flex flex-col gap-0 px-10 pb-12">
          <div class="flex items-center gap-2 pt-4 text-[12.5px] text-fg-3">
            <button type="button" onClick={props.onBack} class="flex items-center gap-1 hover:text-fg-2">
              <Glyph name="chevron-left" size={13} />
              Extensions
            </button>
            <Glyph name="chevron-right" size={11} class="text-fg-4" />
            <span>{summary()?.category ?? "Package"}</span>
            <Glyph name="chevron-right" size={11} class="text-fg-4" />
            <span class="text-fg">{summary()?.title ?? props.name}</span>
          </div>

          <div class="flex items-start gap-4 pt-6">
            <span class="grid h-16 w-16 shrink-0 place-items-center rounded-[12px] border border-line-inner bg-hover text-fg">
              <Glyph name="package" size={30} />
            </span>
            <div class="min-w-0 flex-1">
              <h1 class="type-section">{summary()?.title ?? props.name}</h1>
              <div class="mt-2 flex flex-wrap items-center gap-2.5 text-[13.5px] text-fg-3">
                <Show when={summary()?.author}>
                  {(author) => (
                    <span>
                      by <span class="font-medium text-fg-2">{author()}</span>
                    </span>
                  )}
                </Show>
                <Show when={value()?.kind}>
                  {(kind) => <Chip>{kind() === "bundle" ? "Bundle" : "Code plugin"}</Chip>}
                </Show>
                <Show when={latest()}>
                  {(version) => <span class="font-mono text-[12.5px]">v{version()}</span>}
                </Show>
                <Show when={installed()}>
                  <Chip tone="ok">Installed</Chip>
                </Show>
              </div>
              <Show when={summary()?.description}>
                {(description) => (
                  <p class="mt-2.5 max-w-[640px] text-[14px] leading-relaxed text-fg-2">{description()}</p>
                )}
              </Show>
            </div>
            <div class="flex shrink-0 flex-col items-end gap-2">
              <Show
                when={!installed()}
                fallback={
                  <Button size="sm" onClick={props.onCustomize}>
                    <Glyph name="sliders" size={14} />
                    Configure
                  </Button>
                }
              >
                <Button
                  size="sm"
                  variant="primary"
                  disabled={value() === undefined}
                  onClick={() => setSheet(true)}
                >
                  <Glyph name="download" size={14} />
                  Install
                </Button>
                <span class="text-[11.5px] text-fg-3">You review what mounts first</span>
              </Show>
            </div>
          </div>

          <div class="mt-6 flex flex-wrap gap-7 border-b border-line pb-4">
            <Stat label="Latest" value={latest() ?? "—"} mono />
            <Stat label="Versions" value={String(value()?.versions.length ?? 0)} />
            <Stat label="Mounts" value={`${value()?.rows.length ?? 0} rows`} />
            <Stat label="Requires" value={requires()} />
            <Stat label="Updated" value={ago(latestVersionAt(value()))} />
          </div>

          <div class="flex h-11 items-center gap-0.5 border-b border-line">
            <For each={TABS}>
              {(entry) => (
                <button
                  type="button"
                  onClick={() => setTab(entry.id)}
                  class="flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px]"
                  classList={{ "bg-selected text-fg": tab() === entry.id, "text-fg-3 hover:text-fg-2": tab() !== entry.id }}
                >
                  {entry.label}
                  <Show when={entry.id === "permissions"}>
                    <span class="font-mono text-[11px] text-fg-4">{value()?.rows.length ?? 0}</span>
                  </Show>
                  <Show when={entry.id === "versions"}>
                    <span class="font-mono text-[11px] text-fg-4">{value()?.versions.length ?? 0}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>

          <Show when={detail.state().kind === "loading"}>
            <Pending label="Reading the package" />
          </Show>
          <Show when={failureOf(detail.state())}>
            {(message) => (
              <div class="pt-5">
                <Failure message={message()} onRetry={() => void detail.reload()} />
              </div>
            )}
          </Show>

          <Show when={value()}>
            {(entry) => (
              <div class="grid grid-cols-1 gap-10 pt-6 lg:grid-cols-[1fr_320px]">
                <div class="min-w-0">
                  <Show when={tab() === "overview"}>
                    <div class="flex flex-col gap-5">
                      <Show
                        when={entry().readme !== undefined && entry().readme !== ""}
                        fallback={<Note>The index carries no readme for this version.</Note>}
                      >
                        <pre class="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-fg-2">{entry().readme}</pre>
                      </Show>
                      <Show when={entry().rows.length > 0}>
                        <div>
                          <span class="label mb-2.5 block">What it mounts</span>
                          <Panel>
                            <For each={entry().rows}>
                              {(row) => (
                                <div class="flex items-center gap-2.5 border-b border-line px-3 py-2.5 last:border-0">
                                  <Glyph name="layers" size={14} class="shrink-0 text-fg-3" />
                                  <code class="font-mono text-[12.5px] text-fg">{row.id}</code>
                                  <span class="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{row.plugin}</span>
                                  <Show when={row.disabled}>
                                    <Chip>Off</Chip>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </Panel>
                        </div>
                      </Show>
                    </div>
                  </Show>

                  <Show when={tab() === "permissions"}>
                    <div class="flex flex-col gap-4">
                      <Show
                        when={entry().rows.length > 0}
                        fallback={<Note>This package declares no mount rows.</Note>}
                      >
                        <Panel>
                          <For each={entry().rows}>
                            {(row) => (
                              <div class="flex items-start gap-2.5 border-b border-line px-3.5 py-2.5 last:border-0">
                                <Glyph name="layers" size={14} class="mt-0.5 shrink-0 text-fg-2" />
                                <div class="min-w-0 flex-1">
                                  <span class="block text-[13px] text-fg">Mounts the {row.plugin} row</span>
                                  <span class="mono-meta block">{row.id}</span>
                                </div>
                                <Chip>{row.disabled ? "Off" : "On"}</Chip>
                              </div>
                            )}
                          </For>
                        </Panel>
                      </Show>
                      <Show when={entry().requires.length > 0}>
                        <div>
                          <span class="label mb-2 block">Requires</span>
                          <Panel>
                            <For each={entry().requires}>
                              {(spec) => (
                                <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 last:border-0">
                                  <Glyph name="package" size={14} class="text-fg-3" />
                                  <code class="font-mono text-[12.5px] text-fg">{spec}</code>
                                </div>
                              )}
                            </For>
                          </Panel>
                        </div>
                      </Show>
                      <Note>
                        The index describes mounts and package requirements. Host-level permission details are not in this build
                        yet, so nothing here claims to know a network host list.
                      </Note>
                    </div>
                  </Show>

                  <Show when={tab() === "versions"}>
                    <Panel>
                      <For each={entry().versions}>
                        {(version) => (
                          <div class="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-0">
                            <span class="w-16 shrink-0 font-mono text-[12.5px] text-fg-2">{version.version}</span>
                            <span class="min-w-0 flex-1 text-[12.5px] text-fg-3">
                              {version.publishTimestamp === undefined ? "—" : ago(version.publishTimestamp)}
                            </span>
                            <Chip tone={version.compatible ? "ok" : "bad"}>
                              {version.compatible ? "Compatible" : "Needs another build"}
                            </Chip>
                            <Show when={version.version === latest()}>
                              <Chip>Latest</Chip>
                            </Show>
                          </div>
                        )}
                      </For>
                    </Panel>
                  </Show>

                  <Show when={tab() === "source"}>
                    <Panel>
                      <KeyRow label="Package" value={entry().name} mono />
                      <KeyRow label="Kind" value={entry().kind ?? "unknown"} />
                      <KeyRow label="Requires" value={entry().requires.length === 0 ? "Nothing extra" : entry().requires.join(", ")} mono />
                      <Show when={summary()?.homepage}>
                        {(homepage) => <LinkRow label="Homepage" href={homepage()} />}
                      </Show>
                      <Show when={summary()?.repository}>
                        {(repository) => <LinkRow label="Repository" href={repository()} />}
                      </Show>
                    </Panel>
                  </Show>
                </div>

                <aside class="flex flex-col gap-4">
                  <div class="rounded-[12px] border border-line bg-surface">
                    <div class="flex items-center border-b border-line px-3.5 py-2.5">
                      <span class="label">Status</span>
                    </div>
                    <div class="px-3.5 py-3">
                      <span class="text-[13px] text-fg-2">{statusSentence(entry())}</span>
                      <Show when={entry().status === "update-available"}>
                        <div class="mt-2">
                          <span class="mono-meta">Use Updates to review the new version.</span>
                        </div>
                      </Show>
                    </div>
                  </div>
                  <Note>
                    Installs run as one op. Packages that ship code are recorded as pending and build on the next update;
                    bundles mount immediately.
                  </Note>
                  <Show when={entry().status === "installed"}>
                    <Button
                      size="sm"
                      onClick={props.onCustomize}
                    >
                      <Glyph name="sliders" size={14} />
                      Configure this row
                    </Button>
                  </Show>
                </aside>
              </div>
            )}
          </Show>
        </div>
      </div>

      <Show when={sheet() ? value() : undefined}>
        {(entry) => (
          <InstallSheet
            name={props.name}
            detail={entry()}
            title={summary()?.title ?? props.name}
            author={summary()?.author}
            onClose={() => setSheet(false)}
          />
        )}
      </Show>
    </>
  )
}

function latestVersionAt(detail: MarketDetail | undefined): number | undefined {
  const version = offeredVersion(detail)
  return version?.publishTimestamp
}

function statusSentence(detail: MarketDetail): string {
  switch (detail.status) {
    case "not-installed":
      return "Not installed in this workspace."
    case "installed":
      return "Installed and running at the latest offered version."
    case "update-available":
      return "A newer version is offered for this build."
    case "different-version":
      return "Installed at a version the index does not offer."
    case "provided":
      return "Compiled into this build; it cannot be installed or removed."
  }
}

function Stat(props: { label: string; value: string; mono?: boolean | undefined }): JSX.Element {
  return (
    <div class="flex flex-col gap-1.5">
      <span class="label">{props.label}</span>
      <span class="text-[15px]" classList={{ "font-mono text-[13.5px]": props.mono === true }}>
        {props.value}
      </span>
    </div>
  )
}

function KeyRow(props: { label: string; value: string; mono?: boolean | undefined }): JSX.Element {
  return (
    <div class="flex border-b border-line px-3.5 py-2 text-[13px] last:border-0">
      <span class="w-[110px] shrink-0 text-fg-3">{props.label}</span>
      <span class="min-w-0 break-words text-fg" classList={{ "font-mono text-[12.5px]": props.mono === true }}>
        {props.value}
      </span>
    </div>
  )
}

function LinkRow(props: { label: string; href: string }): JSX.Element {
  return (
    <div class="flex border-b border-line px-3.5 py-2 text-[13px] last:border-0">
      <span class="w-[110px] shrink-0 text-fg-3">{props.label}</span>
      <a href={props.href} target="_blank" rel="noreferrer" class="min-w-0 break-all text-accent-text underline decoration-line-strong underline-offset-[3px] hover:text-fg">
        {props.href}
      </a>
    </div>
  )
}
