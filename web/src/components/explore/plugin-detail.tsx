import { createEffect, createMemo, createSignal, For, on, onMount, Show, type JSX } from "solid-js"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import {
  market,
  marketDetail,
  offeredVersion,
  type MarketDetail,
  type MarketStatus,
  type MarketSummary,
} from "../../state/extensions.ts"
import { Button, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { InstallSheet } from "../extensions/install-sheet.tsx"
import { IntegrityPin } from "../extensions/integrity.tsx"
import { packageLines } from "../extensions/permissions.ts"
import { Card, DetailColumns, ExternalLink, Fact, LoadFailed, LogoTile, Page, SkeletonRows } from "./parts.tsx"
import { crumbsFor, logoOf, pluginAction, statusWord } from "./routes.ts"

function reportHref(summary: MarketSummary | undefined, name: string): string {
  const repo = summary?.repository
  const github = repo === undefined ? undefined : /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?]|$)/u.exec(repo)?.[1]
  if (github !== undefined) return `https://github.com/${github}/issues/new?title=${encodeURIComponent(`Report: ${name}`)}`
  return `mailto:?subject=${encodeURIComponent(`Report: ${name}`)}`
}

const dateOf = (timestamp: number | undefined): string | undefined =>
  timestamp === undefined || timestamp <= 0 ? undefined : new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })

export function PluginDetail(props: { name: string }): JSX.Element {
  const handle = createMemo(() => marketDetail(props.name))
  const [sheet, setSheet] = createSignal(false)

  createEffect(() => void handle().reload())
  createEffect(on(() => props.name, () => setSheet(false), { defer: true }))
  onMount(() => {
    void market.reload()
  })

  const summary = (): MarketSummary | undefined => {
    const state = market.state()
    return state.kind === "ready" ? state.value.find((entry) => entry.name === props.name) : undefined
  }
  const value = (): MarketDetail | undefined => {
    const state = handle().state()
    return state.kind === "ready" ? state.value : undefined
  }
  const title = (): string => summary()?.title ?? props.name
  const status = (): MarketStatus | undefined => value()?.status ?? summary()?.status
  const latest = () => offeredVersion(value())

  return (
    <Page crumbs={crumbsFor("plugins", title())} wide>
      <Show when={failureOf(handle().state())}>
        {(message) => <LoadFailed what={props.name} message={message()} onRetry={() => void handle().reload()} />}
      </Show>
      <Show when={handle().state().kind === "loading"}>
        <SkeletonRows count={4} />
      </Show>
      <Show when={handle().state().kind === "ready" && value() === undefined}>
        <div class="flex flex-col items-start gap-2 py-8">
          <span class="text-base text-ink">No plugin called {props.name}</span>
          <a href="#/explore" class="text-sm text-primary-ink hover:underline">
            Back to plugins
          </a>
        </div>
      </Show>
      <Show when={value()}>
        {(entry) => (
          <DetailColumns
            main={
              <>
                <div class="flex items-start gap-4">
                  <LogoTile src={logoOf(summary() ?? {})} glyph="package" size={48} verified={status() === "provided"} />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-3">
                      <h1 class="min-w-0 text-xl font-normal text-ink">{title()}</h1>
                      <Show
                        when={pluginAction(status()) !== "installed"}
                        fallback={
                          <span class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm text-ink-2 shadow-ring">
                            <Glyph name="check" size={13} />
                            {statusWord(status() ?? "installed")}
                          </span>
                        }
                      >
                        <Show
                          when={pluginAction(status()) === "add"}
                          fallback={
                            <a
                              href="#/extensions/updates"
                              class="im-press inline-flex h-7 shrink-0 items-center rounded-sm px-2.5 text-sm text-ink shadow-ring"
                            >
                              Review update
                            </a>
                          }
                        >
                          <Button size="sm" variant="primary" onClick={() => setSheet(true)}>
                            <Glyph name="plus" size={13} />
                            Add
                          </Button>
                        </Show>
                      </Show>
                    </div>
                    <p class="mt-1.5 text-sm leading-relaxed text-ink-2">
                      {summary()?.description === "" || summary() === undefined ? "No description in the index." : summary()?.description}
                    </p>
                  </div>
                </div>

                <Card title={`${entry().rows.length} ${entry().rows.length === 1 ? "plugin row" : "plugin rows"}`}>
                  <Show
                    when={entry().rows.length > 0}
                    fallback={<p class="px-4 py-3 text-sm text-ink-2">It records the package and mounts nothing of its own.</p>}
                  >
                    <For each={entry().rows}>
                      {(row) => (
                        <div class="flex items-center gap-3 border-b border-line-1 px-4 py-2.5 last:border-0">
                          <Glyph name="layers" size={14} class="shrink-0 text-ink-2" />
                          <span class="min-w-0 flex-1">
                            <code class="block truncate font-mono text-sm text-ink">{row.id}</code>
                            <span class="block truncate text-xs text-ink-2">{row.plugin}</span>
                          </span>
                          <span class="shrink-0 text-xs text-ink-2">{row.disabled ? "Starts off" : "Starts on"}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </Card>

                <Show when={entry().requires.length > 0}>
                  <Card title={`Needs ${entry().requires.length} more`}>
                    <For each={entry().requires}>
                      {(spec) => (
                        <div class="flex items-center gap-3 border-b border-line-1 px-4 py-2.5 last:border-0">
                          <Glyph name="package" size={14} class="shrink-0 text-ink-2" />
                          <code class="truncate font-mono text-sm text-ink">{spec}</code>
                        </div>
                      )}
                    </For>
                  </Card>
                </Show>

                <Show when={entry().readme}>
                  {(readme) => (
                    <Card title="About">
                      <p class="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-ink-2">{readme()}</p>
                    </Card>
                  )}
                </Show>

                <Card title={`${entry().versions.length} ${entry().versions.length === 1 ? "version" : "versions"}`}>
                  <For each={entry().versions.slice(0, 8)}>
                    {(version) => (
                      <div class="flex items-center gap-3 border-b border-line-1 px-4 py-2.5 last:border-0">
                        <span class="font-mono text-sm text-ink">{version.version}</span>
                        <span class="min-w-0 flex-1 truncate text-xs text-ink-2">
                          {version.compatible ? "Works with this Home" : "Needs a newer Home"}
                          {version.skipped ? " · skipped" : ""}
                        </span>
                        <Show when={version.publishTimestamp}>
                          {(at) => (
                            <span class="shrink-0 text-xs text-ink-2" title={dateOf(at())}>
                              {ago(at())}
                            </span>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </Card>
              </>
            }
            side={
              <>
                <Show when={summary()?.repository ?? summary()?.homepage}>
                  {(href) => (
                    <Fact label="Repository">
                      <ExternalLink href={href()}>{href().replace(/^https?:\/\/(www\.)?/u, "")}</ExternalLink>
                    </Fact>
                  )}
                </Show>
                <Fact label="Made by">{summary()?.author ?? (status() === "provided" ? "Ingle" : "Unknown")}</Fact>
                <Show when={latest()}>
                  {(version) => (
                    <Fact label="Version">
                      <span class="font-mono">{version().version}</span>
                      <Show when={dateOf(version().publishTimestamp)}>
                        {(date) => <span class="ml-2 text-ink-2">{date()}</span>}
                      </Show>
                    </Fact>
                  )}
                </Show>
                <Show when={entry().integrity}>
                  {(integrity) => (
                    <Fact label="Registry pin">
                      <IntegrityPin integrity={integrity()} />
                      <span class="mt-1 block text-xs text-ink-3">Checked against the tarball when you install.</span>
                    </Fact>
                  )}
                </Show>
                <Fact label="Kind">{entry().kind === "code" ? "Code plugin" : "Bundle"}</Fact>
                <Fact label="Permissions">
                  <ul class="flex list-disc flex-col gap-1 pl-4 text-ink-2">
                    <For each={packageLines(entry())}>{(line) => <li>{line}</li>}</For>
                  </ul>
                </Fact>
                <div class="flex flex-col items-start gap-2 pt-1">
                  <Show when={pluginAction(status()) === "installed"}>
                    <button type="button" onClick={() => navigate("/extensions/customize")} class="text-sm text-primary-ink hover:underline">
                      Configure
                    </button>
                  </Show>
                  <a href={reportHref(summary(), props.name)} target="_blank" rel="noreferrer noopener" class="text-sm text-ink-2 hover:text-ink">
                    Report
                  </a>
                </div>
              </>
            }
          />
        )}
      </Show>
      <Show when={sheet() && value()}>
        {(entry) => (
          <InstallSheet name={props.name} detail={entry()} title={title()} author={summary()?.author} onClose={() => setSheet(false)} />
        )}
      </Show>
    </Page>
  )
}
