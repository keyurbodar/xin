import "@ui-sdk/web/input"
import { ChevronRight, Search, X } from "lucide-solid"
import { createSignal, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import { host, slotItems, type SlotItem } from "../plugins/slots.tsx"
import { PluginPage } from "./plugin-page.tsx"
import { route } from "../lib/router.ts"
import { Glyph, type GlyphName } from "../components/extensions/glyph.tsx"
import { Breadcrumb } from "../components/ui/breadcrumb.tsx"
import { matches, SearchablePage } from "../components/settings/parts.tsx"
import { General } from "../components/settings/general.tsx"
import { Usage } from "../components/settings/usage.tsx"
import { Models } from "../components/settings/models.tsx"
import { Notifications } from "../components/settings/notifications.tsx"
import { Plugins } from "../components/settings/plugins.tsx"
import { Members } from "../components/settings/members.tsx"
import { Profile } from "../components/settings/profile.tsx"
import { System } from "../components/settings/system.tsx"
import { AppearanceSettings } from "../appearance/page.tsx"

type Tab = "general" | "appearance" | "models" | "usage" | "notifications" | "plugins" | "members" | "profile" | "system"

/** `terms` holds the page's section and row labels, so the nav can find a page by a setting it holds. */
export type Entry = {
  readonly id: Tab
  readonly label: string
  readonly icon: GlyphName
  readonly about: string
  readonly terms: readonly string[]
}

const GENERAL: Entry = {
  id: "general",
  label: "General",
  icon: "settings",
  about: "Your name, model defaults and the instructions every project reads.",
  terms: [
    "Model defaults",
    "Coordinator",
    "Threads",
    "Titles + summaries",
    "Workspace",
    "Your name",
    "Time zone",
    "Reduce motion",
    "Instructions for every project",
  ],
}

export const SECTIONS: readonly { readonly title: string; readonly entries: readonly Entry[] }[] = [
  {
    title: "Account",
    entries: [
      GENERAL,
      {
        id: "appearance",
        label: "Appearance",
        icon: "monitor",
        about: "Theme, background, sizing and code display. Changes show as you make them.",
        terms: [
          "Mode",
          "Appearance sync",
          "Theme",
          "Create theme",
          "Download theme",
          "Delete theme",
          "Colors",
          "Accent",
          "Foreground",
          "Background",
          "Dashboard background",
          "Background effect",
          "Dither colour",
          "Dot size",
          "Effect intensity",
          "Brightness",
          "Blur",
          "Image opacity",
          "Bottom fade",
          "Overlay opacity",
          "Input opacity",
          "Your wallpapers",
          "Interface",
          "Text size",
          "Density",
          "Sidebar width",
          "Side pane width",
          "Code",
          "Code font size",
          "Diff colors",
        ],
      },
      {
        id: "profile",
        label: "Profile + token",
        icon: "user",
        about: "What Ingle knows about you, and the owner token.",
        terms: ["What Ingle knows about you", "Owner token", "Danger", "Sign out everywhere"],
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: "bell",
        about: "Which reports reach this browser, and when they wait.",
        terms: [
          "Push to this browser",
          "This browser",
          "Send test",
          "Tell me when",
          "A thread is waiting on you",
          "A report lands",
          "Something fails",
          "Spend passes the alert",
          "A schedule runs",
          "Quiet hours",
          "Other devices",
        ],
      },
    ],
  },
  {
    title: "Agent",
    entries: [
      {
        id: "models",
        label: "Models + providers",
        icon: "cpu",
        about: "Provider keys and the catalog they unlock.",
        terms: ["Providers", "Add provider", "API key", "Catalog"],
      },
      {
        id: "plugins",
        label: "Plugins",
        icon: "plug",
        about: "Every plugin row in this home. Turn rows on or off and change their settings.",
        terms: ["Optional", "Core", "Packages", "Configure"],
      },
      {
        id: "usage",
        label: "Usage + cost",
        icon: "chart-column",
        about: "What this home spent, by day, project, model and tool.",
        terms: ["Daily spend", "By project", "By model", "By tool", "Limits", "Monthly cap", "Daily alert"],
      },
    ],
  },
  {
    title: "Workspace",
    entries: [
      {
        id: "members",
        label: "Members",
        icon: "users",
        about: "Who can reach this home: the owner and the devices signed in with the token.",
        terms: ["Owner", "Signed-in devices", "Disconnect"],
      },
      {
        id: "system",
        label: "System",
        icon: "server",
        about: "The build, its services, updates and restart.",
        terms: ["Update", "Build packages", "Services", "Version", "Running", "Bundles", "Restart", "Restart now", "Download logs"],
      },
    ],
  },
]

const ENTRIES: readonly Entry[] = SECTIONS.flatMap((section) => section.entries)

function entryOf(part: string | undefined): Entry {
  return ENTRIES.find((entry) => entry.id === part) ?? GENERAL
}

const pluginHref = (item: SlotItem<"settings.page">): string => `#/settings/plugin/${item.plugin}/${item.id}`

const NAV_ITEM =
  "im-press im-hover flex h-[var(--h-row)] shrink-0 items-center gap-2 rounded-sm px-2 text-small whitespace-nowrap outline-none focus-visible:shadow-[0_0_0_2px_var(--color-primary-soft)] aria-[current=page]:bg-secondary aria-[current=page]:text-ink max-sm:aria-[current=page]:bg-transparent"

const NAV_GROUP = "flex flex-col gap-1"

const NAV_LABEL = "px-2 text-mini font-title text-ink-3 max-sm:px-3"

const NAV_LIST =
  "flex flex-col gap-px max-sm:gap-0 max-sm:overflow-hidden max-sm:rounded-lg max-sm:shadow-ring max-sm:[&>a+a]:border-t max-sm:[&>a]:border-line-1 max-sm:[&>a]:rounded-none"

export function SettingsScreen(props: { pages?: Accessor<readonly SlotItem<"settings.page">[]> }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const current = (): Entry => entryOf(route().parts[1])
  const pages = props.pages ?? slotItems("settings.page")
  const page = () =>
    route().parts[1] === "plugin"
      ? pages().find((item) => item.key === `${route().parts[2]}:${route().parts[3]}`)
      : undefined
  const chosen = (): boolean => route().parts[1] !== undefined
  const findable = (entry: Entry): boolean => matches(query(), entry.label, entry.about, ...entry.terms)
  const sections = () =>
    SECTIONS.map((section) => ({ title: section.title, entries: section.entries.filter(findable) })).filter(
      (section) => section.entries.length > 0,
    )
  const plugins = () => pages().filter((item) => matches(query(), item.title))
  const nothing = (): boolean => sections().length === 0 && plugins().length === 0

  const link = (props: { href: string; current: boolean; icon?: GlyphName | undefined; label: string }): JSX.Element => (
    <a
      href={props.href}
      aria-current={props.current ? "page" : undefined}
      class={`${NAV_ITEM} text-ink-2 max-sm:h-[var(--h-control-lg)] max-sm:px-3`}
    >
      <Show when={props.icon}>
        {(icon) => <Glyph name={icon()} size={16} class={props.current ? "text-ink" : "text-ink-3"} />}
      </Show>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
      <ChevronRight size={16} stroke-width={1.5} class="text-icon sm:hidden" aria-hidden="true" />
    </a>
  )

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
      <div
        class="flex min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto px-4 pb-6 pt-4 sm:w-[var(--w-sidebar)] sm:border-r sm:border-line-1 sm:px-2 sm:pt-3"
        classList={{ "max-sm:hidden": chosen() }}
      >
        <h1 class="px-1 text-title-lg font-title text-ink sm:hidden">Settings</h1>
        <ui-input-group class="flex h-[var(--h-control)] items-center gap-2 rounded-sm bg-bg px-2 shadow-ring focus-within:shadow-[0_0_0_1px_var(--color-primary),0_0_0_3px_var(--color-primary-soft)] max-sm:rounded-full max-sm:px-3">
          <Search size={14} stroke-width={1.5} class="shrink-0 text-ink-3" aria-hidden="true" />
          <ui-input class="flex min-w-0 flex-1">
            <input
              type="search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              spellcheck={false}
              autocomplete="off"
              class="min-w-0 flex-1 bg-transparent text-small text-ink outline-none placeholder:text-placeholder [&::-webkit-search-cancel-button]:hidden"
            />
          </ui-input>
          <ui-input-clear>
            <button
              type="button"
              aria-label="Clear search"
              class="grid h-[var(--h-control-xs)] w-[var(--h-control-xs)] place-items-center rounded-xs text-ink-3 hover:text-ink"
            >
              <X size={14} stroke-width={1.5} aria-hidden="true" />
            </button>
          </ui-input-clear>
        </ui-input-group>
        <nav aria-label="Settings" class="flex flex-col gap-3">
          <For each={sections()}>
            {(section) => (
              <div role="group" aria-label={section.title} class={NAV_GROUP}>
                <span aria-hidden="true" class={NAV_LABEL}>
                  {section.title}
                </span>
                <div class={NAV_LIST}>
                <For each={section.entries}>
                  {(entry) =>
                    link({
                      href: `#/settings/${entry.id}`,
                      current: page() === undefined && current().id === entry.id,
                      icon: entry.icon,
                      label: entry.label,
                    })
                  }
                </For>
                </div>
              </div>
            )}
          </For>
          <Show when={plugins().length > 0}>
            <div role="group" aria-label="From plugins" class={NAV_GROUP}>
              <span aria-hidden="true" class={NAV_LABEL}>
                From plugins
              </span>
              <div class={NAV_LIST}>
                <For each={plugins()}>
                  {(item) => link({ href: pluginHref(item), current: page() === item, label: item.title })}
                </For>
              </div>
            </div>
          </Show>
          <Show when={nothing()}>
            <p class="px-2 text-small text-ink-3">No settings match “{query().trim()}”.</p>
          </Show>
        </nav>
      </div>

      <section data-settings-content class="min-h-0 min-w-0 flex-1 overflow-y-auto" classList={{ "max-sm:hidden": !chosen() }}>
        <div class="mx-auto flex w-full max-w-[calc(var(--w-settings)+var(--page-gutter)*2)] flex-col gap-2 px-[var(--page-gutter)] pb-16 pt-6 sm:pt-12">
          <Show
            when={page()}
            keyed
            fallback={
              <>
                <Breadcrumb
                  crumbs={[
                    { label: "Settings", href: "#/settings" },
                    { label: current().label, href: `#/settings/${current().id}` },
                  ]}
                />
                <h1 class="text-title font-title text-ink">{current().label}</h1>
                <p class="text-body text-ink-3">{current().about}</p>
                <Show when={query().trim() !== "" && current().id !== "appearance"}>
                  <div class="flex items-center gap-2 text-small text-ink-3">
                    <span class="min-w-0 truncate">Showing settings that match “{query().trim()}”</span>
                    <button type="button" class="link shrink-0" onClick={() => setQuery("")}>
                      Show all
                    </button>
                  </div>
                </Show>
                <div class="mt-6">
                  <Show when={current().id !== "appearance"} fallback={<AppearanceSettings />}>
                  <SearchablePage
                    query={query()}
                    empty={(text) => (
                      <p class="py-6 text-center text-small text-ink-3">
                        Nothing on {current().label} matches “{text}”.
                      </p>
                    )}
                  >
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
                  </SearchablePage>
                  </Show>
                </div>
              </>
            }
          >
            {(found) => (
              <>
                <Breadcrumb
                  crumbs={[
                    { label: "Settings", href: "#/settings" },
                    { label: found.title, href: pluginHref(found) },
                  ]}
                />
                <PluginPage plugin={found.plugin} title={found.title} component={found.component} host={host} />
              </>
            )}
          </Show>
        </div>
      </section>
    </div>
  )
}
