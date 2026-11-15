import { createEffect, createSignal, ErrorBoundary, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { Menu as MenuIcon } from "lucide-solid"
import { navigate, route } from "../../lib/router.ts"
import { owner } from "../../state/settings.ts"
import { setSidebarDrawer, sidebarDrawer, sidebarHidden, toggleSidebar, wideShell as wide } from "../../state/tabs.ts"
import { Sidebar } from "./sidebar.tsx"
import { ConnectionBanner } from "./connection-banner.tsx"
import { CommandPalette } from "./palette.tsx"
import { NewThreadDialog } from "./new-thread.tsx"
import { ICON_BUTTON } from "./menu.ts"
import { ProjectScreen } from "../../screens/project.tsx"
import { ExtensionsScreen } from "../../screens/extensions.tsx"
import { SettingsScreen } from "../../screens/settings.tsx"
import { SchedulesScreen } from "../../screens/schedules.tsx"
import { NewProjectDialog } from "../project/new-project.tsx"
import "./overlay.css"

export function Shell(): JSX.Element {
  const first = () => route().parts[0]
  const [palette, setPalette] = createSignal(false)
  const project = (): boolean => first() === undefined || first() === "p" || first() === "new"

  createEffect(() => {
    route()
    setSidebarDrawer(false)
  })

  onMount(() => {
    void owner.reload()
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === "k") {
        event.preventDefault()
        setPalette((open) => !open)
      }
      if (key === "b") {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const search = (): void => {
    setSidebarDrawer(false)
    setPalette(true)
  }

  return (
    <div class="flex h-full overflow-hidden bg-bg text-ink">
      <Show when={wide() && !sidebarHidden()}>
        <Sidebar drawer={false} onSearch={search} onCollapse={toggleSidebar} />
      </Show>
      <Show when={!wide() && sidebarDrawer()}>
        <div class="fade-in fixed inset-0 z-[var(--z-sheet)] bg-scrim" onClick={() => setSidebarDrawer(false)} />
        <div class="drawer-in fixed inset-y-0 left-0 z-[var(--z-sheet)] flex shadow-overlay">
          <Sidebar drawer onSearch={search} onCollapse={toggleSidebar} />
        </div>
      </Show>
      <main
        class="flex min-h-0 min-w-0 flex-1 flex-col gap-2 py-2 pr-2"
        classList={{ "pl-2": !wide() || sidebarHidden() }}
      >
        <ConnectionBanner />
        <ErrorBoundary
          fallback={(error: unknown, reset) => (
            <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg bg-panel px-6 text-center shadow-ring">
              <span class="text-base text-ink-2">This screen stopped</span>
              <span class="max-w-[420px] font-mono text-xs text-ink-3">
                {error instanceof Error ? error.message : String(error)}
              </span>
              <button
                type="button"
                onClick={() => reset()}
                class="rounded-sm border border-line-2 px-2.5 py-1 text-sm text-ink-2 hover:border-line-3 hover:bg-secondary"
              >
                Try again
              </button>
            </div>
          )}
        >
          <Show
            when={project()}
            fallback={
              <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-panel shadow-ring">
                <Show when={!wide() || sidebarHidden()}>
                  <div class="flex h-[var(--h-topbar)] shrink-0 items-center border-b border-line-1 px-2">
                    <button type="button" class={ICON_BUTTON} aria-label="Open the sidebar" onClick={toggleSidebar}>
                      <MenuIcon size={16} stroke-width={1.5} />
                    </button>
                  </div>
                </Show>
                <Switch>
                  <Match when={first() === "extensions"}>
                    <ExtensionsScreen />
                  </Match>
                  <Match when={first() === "settings"}>
                    <SettingsScreen />
                  </Match>
                  <Match when={first() === "schedules"}>
                    <SchedulesScreen />
                  </Match>
                </Switch>
              </section>
            }
          >
            <ProjectScreen />
          </Show>
        </ErrorBoundary>
      </main>
      <NewProjectDialog open={first() === "new"} onClose={() => navigate("/")} />
      <NewThreadDialog />
      <CommandPalette open={palette()} onClose={() => setPalette(false)} />
    </div>
  )
}
