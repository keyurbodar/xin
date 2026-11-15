import { For, Match, Switch, type JSX } from "solid-js"
import { navigate, route } from "../lib/router.ts"
import { Glyph, type GlyphName } from "../components/extensions/glyph.tsx"
import { General } from "../components/settings/general.tsx"
import { Usage } from "../components/settings/usage.tsx"
import { Models } from "../components/settings/models.tsx"
import { Notifications } from "../components/settings/notifications.tsx"
import { Plugins } from "../components/settings/plugins.tsx"
import { Members } from "../components/settings/members.tsx"
import { Profile } from "../components/settings/profile.tsx"
import { System } from "../components/settings/system.tsx"

type Tab = "general" | "models" | "usage" | "notifications" | "plugins" | "members" | "profile" | "system"

type Entry = { readonly id: Tab; readonly label: string; readonly icon: GlyphName; readonly about: string }

const GENERAL: Entry = {
  id: "general",
  label: "General",
  icon: "settings",
  about: "Your name, model defaults and the instructions every project reads.",
}

const ENTRIES: readonly Entry[] = [
  GENERAL,
  { id: "models", label: "Models + providers", icon: "cpu", about: "Provider keys and the catalog they unlock." },
  { id: "usage", label: "Usage + cost", icon: "chart-column", about: "What this home spent, by day, project, model and tool." },
  { id: "notifications", label: "Notifications", icon: "bell", about: "Which reports reach this browser, and when they wait." },
  { id: "plugins", label: "Plugins", icon: "plug", about: "Every plugin row in this home. Turn rows on or off and change their settings." },
  { id: "members", label: "Members", icon: "users", about: "Who can reach this home: the owner and the devices signed in with the token." },
  { id: "profile", label: "Profile + token", icon: "user", about: "What Ingle knows about you, and the owner token." },
  { id: "system", label: "System", icon: "server", about: "The build, its services, updates and restart." },
]

function entryOf(part: string | undefined): Entry {
  return ENTRIES.find((entry) => entry.id === part) ?? GENERAL
}

export function SettingsScreen(): JSX.Element {
  const current = (): Entry => entryOf(route().parts[1])

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
      <nav
        aria-label="Settings"
        class="flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line-1 px-2 py-2 sm:w-[200px] sm:flex-col sm:items-stretch sm:gap-px sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-3"
      >
        <For each={ENTRIES}>
          {(entry) => (
            <button
              type="button"
              aria-current={current().id === entry.id ? "page" : undefined}
              onClick={() => navigate(`/settings/${entry.id}`)}
              class="im-press flex h-7 shrink-0 items-center gap-2.5 rounded-md px-2 text-base whitespace-nowrap"
              classList={{
                "bg-card text-ink shadow-ring": current().id === entry.id,
                "im-hover text-ink-2": current().id !== entry.id,
              }}
            >
              <Glyph name={entry.icon} size={16} class={current().id === entry.id ? "text-ink" : "text-ink-3"} />
              {entry.label}
            </button>
          )}
        </For>
      </nav>

      <section class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[800px] px-7 pb-16 pt-8">
          <h1 class="text-xl font-semibold tracking-[-0.015em] text-ink">{current().label}</h1>
          <p class="mt-1 text-sm text-ink-3">{current().about}</p>
          <div class="mt-7">
            <Switch fallback={<General />}>
              <Match when={current().id === "models"}>
                <Models />
              </Match>
              <Match when={current().id === "usage"}>
                <Usage />
              </Match>
              <Match when={current().id === "notifications"}>
                <Notifications />
              </Match>
              <Match when={current().id === "plugins"}>
                <Plugins />
              </Match>
              <Match when={current().id === "members"}>
                <Members />
              </Match>
              <Match when={current().id === "profile"}>
                <Profile />
              </Match>
              <Match when={current().id === "system"}>
                <System />
              </Match>
            </Switch>
          </div>
        </div>
      </section>
    </div>
  )
}
