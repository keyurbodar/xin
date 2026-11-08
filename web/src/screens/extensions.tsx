import { createSignal, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { navigate, route } from "../lib/router.ts"
import { market, rows } from "../state/extensions.ts"
import { Glyph } from "../components/extensions/glyph.tsx"
import { Segmented } from "../components/ui/segmented.tsx"
import { Discover } from "../components/extensions/discover.tsx"
import { PackagePage } from "../components/extensions/package-page.tsx"
import { Installed } from "../components/extensions/installed.tsx"
import { Updates } from "../components/extensions/updates.tsx"
import { Customize } from "../components/extensions/customize.tsx"
import { Sources } from "../components/extensions/sources.tsx"
import { AddUrl } from "../components/extensions/add-url.tsx"

type View = "discover" | "installed" | "updates" | "customize" | "sources" | "package"

const TABS: readonly { readonly id: View; readonly label: string; readonly to: string }[] = [
  { id: "discover", label: "Discover", to: "/extensions" },
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
  const view = (): View => viewOf(route().parts[1])

  const activeTab = (): View | undefined => {
    const current = view()
    if (current === "package") return "discover"
    return TABS.some((tab) => tab.id === current) ? current : undefined
  }

  const installedCount = (): number | undefined => {
    const state = rows.state()
    return state.kind === "ready" ? state.value.length : undefined
  }

  const updateCount = (): number => {
    const state = market.state()
    return state.kind === "ready" ? state.value.filter((entry) => entry.status === "update-available").length : 0
  }

  const tabItems = TABS.map((tab) => ({
    id: tab.id,
    label: (
      <>
        {tab.label}
        <Show when={tab.id === "installed" && installedCount() !== undefined}>
          <span class="font-mono text-[11px] text-fg-4">{installedCount()}</span>
        </Show>
        <Show when={tab.id === "updates" && updateCount() > 0}>
          <span class="font-mono text-[11px] text-accent-text">{updateCount()}</span>
        </Show>
      </>
    ),
  }))

  onMount(() => {
    void rows.reload()
    void market.reload()
  })

  const packageName = (): string | undefined => {
    const part = route().parts[2]
    if (view() !== "package" || part === undefined) return undefined
    try {
      return decodeURIComponent(part)
    } catch {
      return undefined
    }
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
      <header class="flex h-[52px] shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-4">
        <Segmented
          label="Extensions views"
          items={tabItems}
          value={activeTab()}
          onChange={(id) => navigate(TABS.find((tab) => tab.id === id)?.to ?? "/extensions")}
        />

        <div class="ml-auto hidden shrink-0 items-center gap-2 sm:flex">
          <button
            type="button"
            aria-label="Sources"
            onClick={() => navigate("/extensions/sources")}
            class="flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium sm:px-3"
            classList={{
              "bg-selected text-fg": view() === "sources",
              "text-fg-2 hover:bg-hover hover:text-fg": view() !== "sources",
            }}
          >
            <Glyph name="git-branch" size={13} />
            <span class="hidden sm:inline">Sources</span>
          </button>
          <button
            type="button"
            aria-label="Add from URL"
            onClick={() => setAddUrl(true)}
            class="flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-fill px-2.5 text-[13px] font-medium text-fg/80 shadow-[inset_0_var(--hl-y)_0_0_var(--hl-top),0_0_0_0.5px_var(--color-ring-crisp)] hover:bg-fill-strong hover:text-fg sm:px-3"
          >
            <Glyph name="upload" size={13} />
            <span class="hidden sm:inline">Add from URL</span>
          </button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Switch fallback={<Discover onOpen={(name) => navigate(`/extensions/package/${encodeURIComponent(name)}`)} onSources={() => navigate("/extensions/sources")} />}>
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
          <Match when={view() === "package"}>
            <Show
              when={packageName()}
              fallback={<Discover onOpen={(name) => navigate(`/extensions/package/${encodeURIComponent(name)}`)} onSources={() => navigate("/extensions/sources")} />}
            >
              {(name) => (
                <PackagePage
                  name={name()}
                  onBack={() => navigate("/extensions")}
                  onCustomize={() => navigate("/extensions/customize")}
                />
              )}
            </Show>
          </Match>
        </Switch>
      </div>

      <Show when={addUrl()}>
        <AddUrl onClose={() => setAddUrl(false)} />
      </Show>
    </>
  )
}
