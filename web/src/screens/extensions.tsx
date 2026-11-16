import { createSignal, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { navigate, route } from "../lib/router.ts"
import { market, rows } from "../state/extensions.ts"
import { Glyph } from "../components/extensions/glyph.tsx"
import { Explore } from "../components/explore/explore.tsx"
import { exploreViewOf, type ExploreView } from "../components/explore/routes.ts"
import { Installed } from "../components/extensions/installed.tsx"
import { Updates } from "../components/extensions/updates.tsx"
import { Customize } from "../components/extensions/customize.tsx"
import { Sources } from "../components/extensions/sources.tsx"
import { AddUrl } from "../components/extensions/add-url.tsx"

type View = "discover" | "installed" | "updates" | "customize" | "sources" | "package"

const TABS: readonly { readonly id: View; readonly label: string; readonly to: string }[] = [
  { id: "discover", label: "Explore", to: "/explore" },
  { id: "installed", label: "Installed", to: "/extensions/installed" },
  { id: "updates", label: "Updates", to: "/extensions/updates" },
  { id: "customize", label: "Customize", to: "/extensions/customize" },
]

function viewOf(part: string | undefined): View {
  switch (part) {
    case "installed":
      return "installed"
    case "updates":
      return "updates"
    case "customize":
      return "customize"
    case "sources":
      return "sources"
    case "package":
      return "package"
    default:
      return "discover"
  }
}

export function ExtensionsScreen(): JSX.Element {
  const [addUrl, setAddUrl] = createSignal(false)
  const view = (): View => (route().parts[0] === "explore" ? "discover" : viewOf(route().parts[1]))

  onMount(() => {
    void rows.reload()
    void market.reload()
  })

  const installedCount = (): number | undefined => {
    const state = rows.state()
    return state.kind === "ready" ? state.value.length : undefined
  }

  const updateCount = (): number => {
    const state = market.state()
    return state.kind === "ready" ? state.value.filter((entry) => entry.status === "update-available").length : 0
  }

  const exploreView = (): ExploreView => {
    const parts = route().parts
    if (parts[0] === "explore") return exploreViewOf(parts.slice(1))
    const name = parts[2]
    return view() === "package" && name !== undefined ? exploreViewOf(["plugins", name]) : { kind: "list", tab: "plugins" }
  }

  const customizeRow = (): string | undefined => {
    const part = route().parts[2]
    if (view() !== "customize" || part === undefined) return undefined
    try {
      return decodeURIComponent(part)
    } catch {
      return undefined
    }
  }

  return (
    <>
      <header class="flex h-12 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-1 px-4">
        {TABS.map((tab) => (
          <button
            type="button"
            onClick={() => navigate(tab.to)}
            class="flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-base"
            classList={{
              "bg-hover text-ink": view() === tab.id || (tab.id === "discover" && view() === "package"),
              "text-ink-3 hover:text-ink-2": view() !== tab.id,
            }}
          >
            {tab.label}
            <Show when={tab.id === "installed" && installedCount() !== undefined}>
              <span class="font-mono text-2xs text-icon">{installedCount()}</span>
            </Show>
            <Show when={tab.id === "updates" && updateCount() > 0}>
              <span class="font-mono text-2xs text-primary-ink">{updateCount()}</span>
            </Show>
          </button>
        ))}

        <div class="ml-auto hidden shrink-0 items-center gap-2 sm:flex">
          <button
            type="button"
            aria-label="Sources"
            onClick={() => navigate("/extensions/sources")}
            class="flex h-7 items-center gap-1.5 rounded-sm border px-2 text-sm font-medium sm:px-2.5"
            classList={{
              "border-line-1 bg-panel text-ink": view() === "sources",
              "border-transparent text-ink-2 hover:text-ink": view() !== "sources",
            }}
          >
            <Glyph name="git-branch" size={13} />
            <span class="hidden sm:inline">Sources</span>
          </button>
          <button
            type="button"
            aria-label="Add from URL"
            onClick={() => setAddUrl(true)}
            class="flex h-7 items-center gap-1.5 rounded-sm border border-line-2 bg-card px-2 text-sm font-medium text-ink hover:border-line-3 hover:bg-secondary sm:px-2.5"
          >
            <Glyph name="upload" size={13} />
            <span class="hidden sm:inline">Add from URL</span>
          </button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Switch fallback={<Explore view={exploreView()} />}>
          <Match when={view() === "installed"}>
            <Installed onCustomize={(rowId) => navigate(`/extensions/customize/${encodeURIComponent(rowId)}`)} />
          </Match>
          <Match when={view() === "updates"}>
            <Updates />
          </Match>
          <Match when={view() === "customize"}>
            <Customize initialRowId={customizeRow()} />
          </Match>
          <Match when={view() === "sources"}>
            <Sources />
          </Match>
        </Switch>
      </div>

      <Show when={addUrl()}>
        <AddUrl onClose={() => setAddUrl(false)} />
      </Show>
    </>
  )
}
