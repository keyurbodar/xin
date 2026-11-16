import { createEffect, createMemo, createSignal, ErrorBoundary, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
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
import { CaptainScreen } from "../../screens/captain.tsx"
import { closeNewCaptain, newCaptainOpen } from "../captain/captain-dialog.tsx"
import { Dialog } from "../ui/dialog.tsx"
import { NewProjectDialog } from "../project/new-project.tsx"
import { createPresence } from "./presence.ts"
import { Toasts } from "../ui/toast.tsx"
import { RowSkeleton } from "../ui/skeleton.tsx"
import { Stopped } from "../ui/stopped.tsx"
import { lazyView } from "../ui/lazy-view.tsx"

const screenSkeleton = (): JSX.Element => <RowSkeleton rows={8} />
export const ExtensionsScreen = lazyView(() => import("../../screens/extensions.tsx").then((module) => module.ExtensionsScreen), screenSkeleton)
const SettingsScreen = lazyView(() => import("../../screens/settings.tsx").then((module) => module.SettingsScreen), screenSkeleton)
const AutomationsScreen = lazyView(() => import("../../screens/automations.tsx").then((module) => module.AutomationsScreen), screenSkeleton)
const NewCaptainDialog = lazyView(() => import("../captain/new-captain.tsx").then((module) => module.NewCaptainDialog), () => <></>)

/**
 * The lazy screens and dialogs by the label of the sidebar control that opens each one. sidebar.tsx gives its rows no
 * route of their own (another lane owns it), so the shell matches a hovered or focused row by its text, or an icon
 * button by its aria-label, to start the chunk early.
 */
const PREFETCH: Readonly<Record<string, () => void>> = {
  Automations: () => void AutomationsScreen.preload(),
  "New Captain": () => void NewCaptainDialog.preload(),
  Extensions: () => void ExtensionsScreen.preload(),
  Settings: () => void SettingsScreen.preload(),
}

function prefetch(event: Event): void {
  const row = event.target instanceof Element ? event.target.closest("button, [role=menuitem]") : null
  PREFETCH[row?.textContent?.trim() || (row?.getAttribute("aria-label") ?? "")]?.()
}

export function Shell(): JSX.Element {
  const first = () => route().parts[0]
  const [palette, setPalette] = createSignal(false)
  const project = (): boolean => first() === undefined || first() === "p" || first() === "new"
  const captainRequested = createMemo((asked: boolean) => asked || newCaptainOpen(), false)
  const drawer = createPresence(() => !wide() && sidebarDrawer(), 180)

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
    <div class="flex h-full overflow-hidden bg-bg text-ink" onPointerOver={prefetch} onFocusIn={prefetch}>
      <Show when={wide() && !sidebarHidden()}>
        <Sidebar drawer={false} onSearch={search} onCollapse={toggleSidebar} />
      </Show>
      <Show when={drawer.mounted()}>
        <div
          class="im-scrim fixed inset-0 z-40 bg-scrim"
          data-state={drawer.leaving() ? "closed" : "open"}
          onClick={() => setSidebarDrawer(false)}
        />
        <div
          class="im-sheet fixed inset-y-0 left-0 z-40 flex shadow-overlay"
          classList={{ "pointer-events-none": drawer.leaving() }}
          data-side="left"
          data-state={drawer.leaving() ? "closed" : "open"}
        >
          <Sidebar drawer onSearch={search} onCollapse={toggleSidebar} />
        </div>
      </Show>
      <main
        class="flex min-h-0 min-w-0 flex-1 flex-col gap-2 py-2 pr-2"
        classList={{ "pl-2": !wide() || sidebarHidden() }}
      >
        <ConnectionBanner />
        <ErrorBoundary
          fallback={(error: unknown, reset) => {
            createEffect(on(() => route().path, reset, { defer: true }))
            return <Stopped title="This screen stopped" error={error} onRetry={reset} class="min-h-0 flex-1 rounded-lg bg-panel shadow-ring" />
          }}
        >
          <Show when={first() !== "c"} fallback={<CaptainScreen />}>
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
                    <Match when={first() === "extensions" || first() === "explore"}>
                      <ExtensionsScreen />
                    </Match>
                    <Match when={first() === "settings"}>
                      <SettingsScreen />
                    </Match>
                    <Match when={first() === "automations"}>
                      <AutomationsScreen />
                    </Match>
                  </Switch>
                </section>
              }
            >
              <ProjectScreen />
            </Show>
          </Show>
        </ErrorBoundary>
      </main>
      <NewProjectDialog open={first() === "new"} onClose={() => navigate("/")} />
      <NewThreadDialog />
      <ErrorBoundary
        fallback={(error: unknown, reset) => {
          createEffect(on(newCaptainOpen, (open) => open && reset(), { defer: true }))
          return (
            <Dialog open={newCaptainOpen()} onClose={closeNewCaptain} title="New Captain">
              <Stopped title="New Captain didn't load" error={error} onRetry={reset} class="py-6" />
            </Dialog>
          )
        }}
      >
        <Show when={captainRequested()}>
          <NewCaptainDialog />
        </Show>
      </ErrorBoundary>
      <CommandPalette open={palette()} onClose={() => setPalette(false)} />
      <Toasts />
    </div>
  )
}
