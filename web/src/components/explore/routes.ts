import type { Palette } from "../../appearance/model.ts"
import type { MarketStatus } from "../../state/extensions.ts"
import type { ExploreTheme } from "../../state/explore.ts"
import type { Crumb } from "./parts.tsx"

export type ExploreTab = "plugins" | "skills" | "themes"

export type ExploreView =
  | { readonly kind: "list"; readonly tab: ExploreTab }
  | { readonly kind: "plugin"; readonly name: string }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "theme"; readonly id: string }

const decode = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

/** `/explore`, `/explore/skills`, `/explore/themes`, and `/explore/<plugins|skills|themes>/<name>`. */
export function exploreViewOf(parts: readonly string[]): ExploreView {
  const [tab, item] = parts
  const name = item === undefined ? undefined : decode(item)
  if (tab === "skills") return name === undefined ? { kind: "list", tab: "skills" } : { kind: "skill", name }
  if (tab === "themes") return name === undefined ? { kind: "list", tab: "themes" } : { kind: "theme", id: name }
  if (tab === "plugins" && name !== undefined) return { kind: "plugin", name }
  return { kind: "list", tab: "plugins" }
}

export const TAB_PATH: Readonly<Record<ExploreTab, string>> = {
  plugins: "/explore",
  skills: "/explore/skills",
  themes: "/explore/themes",
}

export const TAB_LABEL: Readonly<Record<ExploreTab, string>> = { plugins: "Plugins", skills: "Skills", themes: "Themes" }

export const pluginPath = (name: string): string => `/explore/plugins/${encodeURIComponent(name)}`
export const skillPath = (name: string): string => `/explore/skills/${encodeURIComponent(name)}`
export const themePath = (id: string): string => `/explore/themes/${encodeURIComponent(id)}`

export const crumbsFor = (tab: ExploreTab, item?: string): readonly Crumb[] => [
  { label: "Explore", to: TAB_PATH.plugins },
  { label: TAB_LABEL[tab], to: TAB_PATH[tab] },
  ...(item === undefined ? [] : [{ label: item }]),
]

/** A GitHub owner's avatar when the repository is on GitHub; the tile shows the glyph until it loads. */
export function logoOf(entry: { readonly repository?: string | undefined; readonly homepage?: string | undefined }): string | undefined {
  const url = entry.repository ?? entry.homepage
  const owner = url === undefined ? undefined : /github\.com[/:]([\w.-]+)/u.exec(url)?.[1]
  return owner === undefined ? undefined : `https://github.com/${owner}.png?size=64`
}

export function statusWord(status: MarketStatus): string | undefined {
  switch (status) {
    case "installed":
    case "different-version":
      return "Installed"
    case "update-available":
      return "Update"
    case "provided":
      return "Built in"
    case "not-installed":
      return undefined
  }
}

export type PluginAction = "add" | "review-update" | "installed"

/** What a plugin's detail page offers: an update is reviewed on Updates, because `market.install` refuses a package that is already installed. */
export function pluginAction(status: MarketStatus | undefined): PluginAction {
  switch (status) {
    case undefined:
    case "not-installed":
      return "add"
    case "update-available":
      return "review-update"
    case "installed":
    case "different-version":
    case "provided":
      return "installed"
  }
}

export function themePalette(theme: ExploreTheme): Palette {
  return theme.scheme === "dark" ? theme.dark : theme.light
}
