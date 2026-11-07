import { Match, Switch, type JSX } from "solid-js"
import { route } from "../../lib/router.ts"
import { Sidebar } from "./sidebar.tsx"
import { HomeScreen } from "../../screens/home.tsx"
import { InboxScreen } from "../../screens/inbox.tsx"
import { ProjectScreen } from "../../screens/project.tsx"
import { ExtensionsScreen } from "../../screens/extensions.tsx"
import { SettingsScreen } from "../../screens/settings.tsx"

export function Shell(): JSX.Element {
  const first = () => route().parts[0]

  return (
    <div class="flex h-full overflow-hidden bg-page text-fg">
      <Sidebar />
      <main class="flex min-w-0 flex-1 flex-col">
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
        </Switch>
      </main>
    </div>
  )
}
