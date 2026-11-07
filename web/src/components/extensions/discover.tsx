import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { market, packages, rows, type MarketStatus, type MarketSummary } from "../../state/extensions.ts"
import { Button, Chip, Empty, Failure, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph, type GlyphName } from "./glyph.tsx"

function readyBundles() {
  const state = packages.state()
  return state.kind === "ready" ? state.value.bundles : undefined
}

function readyRows() {
  const state = rows.state()
  return state.kind === "ready" ? state.value : undefined
}

function glyphFor(category: string | undefined): GlyphName {
  switch (category?.toLowerCase()) {
    case "connector":
    case "connectors":
      return "plug"
    case "skill":
    case "skills":
      return "book-open"
    case "tool":
    case "tools":
      return "terminal"
    case "prompt":
    case "prompts":
      return "scroll-text"
    case "preset":
    case "presets":
      return "layers"
    case "theme":
    case "themes":
      return "panel"
    default:
      return "package"
  }
}

function actionLabel(status: MarketStatus): string {
  switch (status) {
    case "not-installed":
      return "Install"
    case "update-available":
      return "Update"
    case "installed":
      return "Installed"
    case "different-version":
      return "Installed"
    case "provided":
      return "Built in"
  }
}

export function Discover(props: { onOpen: (name: string) => void; onSources: () => void }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [category, setCategory] = createSignal("All")

  onMount(() => {
    void market.reload()
    void packages.reload()
    void rows.reload()
  })

  const entries = (): readonly MarketSummary[] => {
    const state = market.state()
    return state.kind === "ready" ? state.value : []
  }

  const categories = createMemo<readonly (readonly [string, number])[]>(() => {
    const counts = new Map<string, number>()
    for (const entry of entries()) {
      const key = entry.category ?? "Other"
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const list: (readonly [string, number])[] = [["All", entries().length]]
    for (const [name, count] of [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      list.push([name, count])
    }
    return list
  })

  const filtered = createMemo(() => {
    const text = query().trim().toLowerCase()
    return entries().filter((entry) => {
      if (category() !== "All" && (entry.category ?? "Other") !== category()) return false
      if (text === "") return true
      return [entry.name, entry.title, entry.description, entry.author ?? "", entry.category ?? ""].some((value) =>
        value.toLowerCase().includes(text),
      )
    })
  })

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex flex-col gap-6 px-8 pb-12 pt-6">
      <div class="flex h-10 items-center gap-2.5 rounded-[2px] border border-line-inner bg-surface px-3">
        <Glyph name="search" size={15} class="text-fg-3" />
        <input
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search extensions: connectors, skills, tools, presets"
          spellcheck={false}
          class="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-fg placeholder:text-fg-4 focus:outline-none"
          aria-label="Search the market"
        />
        <span class="kbd">/</span>
      </div>

      <Show when={failureOf(market.state())}>
        {(message) => <Failure message={message()} onRetry={() => void market.reload()} />}
      </Show>

      <Show when={entries().length > 0}>
      <div class="flex flex-wrap gap-1.5">
        <For each={categories()}>
          {([name, count]) => (
            <button
              type="button"
              onClick={() => setCategory(name)}
              class="inline-flex h-7 items-center gap-1.5 rounded-[2px] border px-2.5 text-[12.5px] transition-none"
              classList={{
                "border-fg bg-fg font-medium text-page": category() === name,
                "border-line-inner text-fg-2 hover:border-line-strong hover:text-fg": category() !== name,
              }}
            >
              {name}
              <span class="font-mono text-[10.5px]" classList={{ "text-page/60": category() === name, "text-fg-4": category() !== name }}>
                {count}
              </span>
            </button>
          )}
        </For>
      </div>
      </Show>

      <Show when={market.state().kind === "loading"}>
        <Pending label="Reading the market" />
      </Show>

      <Show when={market.state().kind === "ready" && entries().length === 0}>
        <Empty
          title="No market index is configured."
          detail="Discover searches the index URLs in Sources. Add one to see connectors, skills, tools and presets here."
        >
          <Button size="sm" onClick={props.onSources}>
            <Glyph name="link" size={14} />
            Open Sources
          </Button>
        </Empty>
      </Show>

      <Show when={filtered().length > 0}>
        <section class="flex flex-col gap-3">
          <div class="flex items-baseline gap-2.5">
            <span class="label">Market</span>
            <span class="text-[12px] text-fg-3">{filtered().length} packages</span>
            <Show when={query().trim() !== ""}>
              <span class="ml-auto text-[12px] text-fg-3">Search: {query().trim()}</span>
            </Show>
          </div>
          <div class="grid grid-cols-1 overflow-hidden rounded-[4px] border border-line md:grid-cols-2 xl:grid-cols-3">
            <For each={filtered()}>{(entry) => <MarketCard entry={entry} onOpen={props.onOpen} />}</For>
          </div>
        </section>
      </Show>

      <Show when={entries().length > 0 && filtered().length === 0}>
        <Empty title="Nothing matches that search." detail="Try a package name, an author, or a category chip above.">
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setQuery("")
              setCategory("All")
            }}
          >
            Clear search
          </Button>
        </Empty>
      </Show>

      <Show when={readyBundles()}>
        {(bundles) => {
          const list = () => bundles()
          return (
            <Show when={list().length > 0}>
              <section class="flex flex-col gap-2.5">
                <div class="flex items-baseline gap-2.5">
                  <span class="label">Runtime bundles</span>
                  <span class="text-[12px] text-fg-3">Installed without a rebuild</span>
                </div>
                <Panel>
                  <For each={list()}>
                    {(bundle) => (
                      <div class="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-0">
                        <span class="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg-2">
                          <Glyph name="package" size={15} />
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-[12.5px] text-fg">{bundle.package}</span>
                          <span class="block truncate text-[11.5px] text-fg-3">
                            {bundle.source.kind === "registry" ? `v${bundle.source.version}` : "local"} · {bundle.rows.length}{" "}
                            {bundle.rows.length === 1 ? "row" : "rows"}
                            {bundle.requires.length > 0 ? ` · requires ${bundle.requires.join(", ")}` : ""}
                          </span>
                        </span>
                      </div>
                    )}
                  </For>
                </Panel>
              </section>
            </Show>
          )
        }}
      </Show>

      <Show when={readyRows()}>
        {(list) => (
          <Note>
            {list().length} plugin rows are composed into this build. Everything here runs in it; nothing is fetched from a
            market until you install it.
          </Note>
        )}
      </Show>
      </div>
    </div>
  )
}

function MarketCard(props: { entry: MarketSummary; onOpen: (name: string) => void }): JSX.Element {
  return (
    <div class="flex gap-3 border-b border-r border-line bg-surface p-3.5 last:border-r-0 hover:bg-hover">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg">
        <Glyph name={glyphFor(props.entry.category)} size={18} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <button type="button" onClick={() => props.onOpen(props.entry.name)} class="flex min-w-0 items-center gap-1.5 text-left">
          <span class="truncate text-[13px] font-medium text-fg">{props.entry.title}</span>
          <Show when={props.entry.status === "provided"}>
            <Chip>Official</Chip>
          </Show>
          <Show when={props.entry.status === "update-available"}>
            <Chip tone="accent">Update</Chip>
          </Show>
        </button>
        <p class="line-clamp-2 text-[12px] leading-snug text-fg-3">
          {props.entry.description === "" ? "No description in the index." : props.entry.description}
        </p>
        <div class="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-fg-4">
          <span>{props.entry.category ?? "Package"}</span>
          <Show when={props.entry.author}>
            {(author) => (
              <>
                <span>·</span>
                <span>by {author()}</span>
              </>
            )}
          </Show>
        </div>
      </div>
      <Button
        size="sm"
        variant={props.entry.status === "not-installed" || props.entry.status === "update-available" ? "ghost" : "quiet"}
        disabled={props.entry.status === "provided"}
        onClick={() => props.onOpen(props.entry.name)}
      >
        {actionLabel(props.entry.status)}
      </Button>
    </div>
  )
}
