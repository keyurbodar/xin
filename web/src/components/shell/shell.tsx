import { createSignal, ErrorBoundary, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { route } from "../../lib/router.ts"
import { mediaQuery } from "../../lib/media.ts"
import { Sidebar } from "./sidebar.tsx"
import { ConnectionBanner } from "./connection-banner.tsx"
import { TabBar } from "./tabbar.tsx"
import { CommandPalette } from "./palette.tsx"
import { HomeScreen } from "../../screens/home.tsx"
import { InboxScreen } from "../../screens/inbox.tsx"
import { ProjectScreen } from "../../screens/project.tsx"
import { ExtensionsScreen } from "../../screens/extensions.tsx"
import { SettingsScreen } from "../../screens/settings.tsx"
import { SchedulesScreen } from "../../screens/schedules.tsx"
import { NewProjectDialog } from "../project/new-project.tsx"
import { navigate } from "../../lib/router.ts"
import { owner } from "../../state/settings.ts"

export function Shell(): JSX.Element {
  const first = () => route().parts[0]
  const [palette, setPalette] = createSignal(false)
  const full = mediaQuery("(min-width: 1280px)")

  onMount(() => {
    void owner.reload()
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPalette((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <div class="flex h-full flex-col overflow-hidden bg-page text-fg lg:flex-row">
      <div class="hidden h-full lg:flex">
        <Show when={full()} keyed fallback={<Sidebar rail onSearch={() => setPalette(true)} />}>
          {(_wide) => <Sidebar onSearch={() => setPalette(true)} />}
        </Show>
      </div>
      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <ErrorBoundary
          fallback={(error: unknown, reset) => (
            <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <span class="text-[13px] text-fg-2">This screen stopped</span>
              <span class="max-w-[420px] font-mono text-[11.5px] text-fg-3">
                {error instanceof Error ? error.message : String(error)}
              </span>
              <button
                type="button"
                onClick={() => reset()}
                class="rounded-[2px] border border-line-inner px-2.5 py-1 text-[12px] text-fg-2 hover:border-line-strong hover:bg-hover"
              >
                Try again
              </button>
            </div>
          )}
        >
          <Switch fallback={<HomeScreen />}>
            <Match when={first() === "p"}>
              <ProjectScreen />
            </Match>
            <Match when={first() === "inbox"}>
              <InboxScreen />
            </Match>
            <Match when={first() === "extensions"}>
              <ExtensionsScreen />
            </Match>
            <Match when={first() === "settings"}>
              <SettingsScreen />
            </Match>
            <Match when={first() === "schedules"}>
              <SchedulesScreen />
            </Match>
            <Match when={first() === "new"}>
              <HomeScreen />
            </Match>
          </Switch>
        </ErrorBoundary>
      </main>
      <NewProjectDialog open={first() === "new"} onClose={() => navigate("/")} />
      <TabBar />
      <CommandPalette open={palette()} onClose={() => setPalette(false)} />
    </div>
  )
}
