import { For, Match, Show, Switch, type JSX } from "solid-js"
import { navigate, route } from "../lib/router.ts"
import { Glyph, type GlyphName } from "../components/extensions/glyph.tsx"
import { General } from "../components/settings/general.tsx"
import { Usage } from "../components/settings/usage.tsx"
import { Models } from "../components/settings/models.tsx"
import { Notifications } from "../components/settings/notifications.tsx"
import { Profile } from "../components/settings/profile.tsx"
import { System } from "../components/settings/system.tsx"

type Tab = "general" | "usage" | "models" | "notifications" | "profile" | "system"

type Entry = { readonly id: Tab; readonly label: string; readonly icon: GlyphName }

const GROUPS: readonly { readonly title: string; readonly entries: readonly Entry[] }[] = [
  {
    title: "Workspace",
    entries: [
      { id: "general", label: "General", icon: "settings" },
      { id: "usage", label: "Usage + cost", icon: "chart-column" },
      { id: "models", label: "Models + providers", icon: "cpu" },
      { id: "notifications", label: "Notifications", icon: "bell" },
    ],
  },
  {
    title: "Account",
    entries: [{ id: "profile", label: "Profile + token", icon: "user" }],
  },
  {
    title: "App",
    entries: [{ id: "system", label: "System", icon: "server" }],
  },
]

const TITLES: Readonly<Record<Tab, string>> = {
  general: "General",
  usage: "Usage + cost",
  models: "Models + providers",
  notifications: "Notifications",
  profile: "Profile + token",
  system: "System",
}

function tabOf(part: string | undefined): Tab {
  switch (part) {
    case "usage":
      return "usage"
    case "models":
      return "models"
    case "notifications":
      return "notifications"
    case "profile":
      return "profile"
    case "system":
      return "system"
    default:
      return "general"
  }
}

export function SettingsScreen(): JSX.Element {
  const tab = (): Tab => tabOf(route().parts[1])

  return (
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <nav class="flex w-[232px] shrink-0 flex-col gap-px overflow-y-auto border-r border-line bg-surface px-2 py-3.5">
        <span class="label px-2.5 pb-1.5 pt-1">Settings</span>
        <For each={GROUPS}>
          {(group) => (
            <>
              <span class="label px-2.5 pb-1 pt-3">{group.title}</span>
              <For each={group.entries}>
                {(entry) => (
                  <button
                    type="button"
                    onClick={() => navigate(`/settings/${entry.id}`)}
                    class="flex h-8 items-center gap-2.5 rounded-[2px] px-2.5 text-[13px] transition-none"
                    classList={{
                      "bg-selected text-fg": tab() === entry.id,
                      "text-fg-2 hover:bg-hover": tab() !== entry.id,
                    }}
                  >
                    <Glyph name={entry.icon} size={14} class={tab() === entry.id ? "text-fg" : "text-fg-3"} />
                    {entry.label}
                  </button>
                )}
              </For>
            </>
          )}
        </For>
      </nav>

      <section class="flex min-w-0 flex-1 flex-col">
        <header class="flex h-14 shrink-0 items-center gap-3 border-b border-line px-7">
          <h1 class="text-[16px] font-medium text-fg">{TITLES[tab()]}</h1>
          <Show when={tab() !== "profile"}>
            <span class="ml-auto text-[11.5px] text-fg-3">One owner</span>
          </Show>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-7 py-5">
          <Switch fallback={<General />}>
            <Match when={tab() === "usage"}>
              <Usage />
            </Match>
            <Match when={tab() === "models"}>
              <Models />
            </Match>
            <Match when={tab() === "notifications"}>
              <Notifications />
            </Match>
            <Match when={tab() === "profile"}>
              <Profile />
            </Match>
            <Match when={tab() === "system"}>
              <System />
            </Match>
          </Switch>
        </div>
      </section>
    </div>
  )
}
