import { createSignal, Match, onCleanup, onMount, Switch, type JSX } from "solid-js"
import { route } from "../../lib/router.ts"
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

export function Shell(): JSX.Element {
  const first = () => route().parts[0]
  const [palette, setPalette] = createSignal(false)

  onMount(() => {
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
        <Sidebar onSearch={() => setPalette(true)} />
      </div>
      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
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
            <NewProjectDialog open onClose={() => navigate("/")} />
          </Match>
        </Switch>
      </main>
      <TabBar />
      <CommandPalette open={palette()} onClose={() => setPalette(false)} />
    </div>
  )
}
