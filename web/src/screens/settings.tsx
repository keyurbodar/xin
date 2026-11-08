import { For, Match, Show, Switch, type JSX } from "solid-js"
import { navigate, route } from "../lib/router.ts"
import { Glyph, type GlyphName } from "../components/extensions/glyph.tsx"
import { GlideList } from "../components/ui/glide.tsx"
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
    <div class="flex min-h-0 flex-1 flex-col sm:p-6">
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-page sm:mx-auto sm:w-full sm:max-w-[1240px] sm:flex-row sm:rounded-[20px] sm:border sm:border-line-inner sm:shadow-[var(--shadow-float)]">
        <nav class="flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2 sm:w-[240px] sm:flex-col sm:items-stretch sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-3 sm:py-5">
          <span class="hidden px-2.5 pb-3.5 text-[18px] leading-6 font-semibold text-fg sm:inline">Settings</span>
          <For each={GROUPS}>
            {(group) => (
              <>
                <span class="hidden px-2.5 pb-1.5 pt-4 text-[12.5px] text-fg-3 sm:inline">{group.title}</span>
                <GlideList class="flex flex-row gap-px sm:flex-col" radius="8px" active={tab()}>
                  <For each={group.entries}>
                    {(entry) => (
                      <button
                        type="button"
                        data-glide-item=""
                        data-glide-value={entry.id}
                        data-glide-active={tab() === entry.id ? "true" : undefined}
                        onClick={() => navigate(`/settings/${entry.id}`)}
                        class="glide-item flex h-[34px] shrink-0 items-center gap-[11px] rounded-[8px] px-2.5 text-[14px] whitespace-nowrap"
                        classList={{
                          "font-medium text-fg": tab() === entry.id,
                          "text-fg-2": tab() !== entry.id,
                        }}
                      >
                        <Glyph name={entry.icon} size={16} class={tab() === entry.id ? "text-fg" : "text-fg-3"} />
                        {entry.label}
                      </button>
                    )}
                  </For>
                </GlideList>
              </>
            )}
          </For>
        </nav>

        <section class="flex min-w-0 flex-1 flex-col">
          <header class="flex h-16 shrink-0 items-center gap-3 border-b border-line px-5 sm:px-8">
            <h1 class="type-section text-fg">{TITLES[tab()]}</h1>
            <Show when={tab() !== "profile"}>
              <span class="ml-auto text-[11.5px] text-fg-3">One owner</span>
            </Show>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
            <div class="mx-auto flex w-full max-w-[820px] flex-col gap-7">
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
          </div>
        </section>
      </div>
    </div>
  )
}
