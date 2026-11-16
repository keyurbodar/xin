import type { Component } from "solid-js"
import type { EntryView } from "../state/conversation.ts"

export { entryBatchRows, entryText, entryToolCalls } from "../state/conversation.ts"
export type { BatchRow, EntryView, ToolCallView } from "../state/conversation.ts"

export type ComposerHandle = {
  readonly insert: (text: string) => void
  readonly submit: (text: string) => void
}

export type Host = {
  readonly cmd: <T = unknown>(op: string, args?: Record<string, unknown>) => Promise<T>
  readonly navigate: (path: string) => void
  readonly conversation: () => number | undefined
  readonly composer: ComposerHandle
  readonly toast: (text: string) => void
}

export type PaneConversation = {
  readonly id: number
  readonly entries: readonly EntryView[]
}

export type ToolCallStatus = "running" | "done" | "error"

export type RenderedCall = {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly output: string | undefined
  readonly details: unknown
  readonly status: ToolCallStatus
}

export type ThemeTokens = Readonly<Partial<Record<ThemeToken, string>>>

export const THEME_TOKENS = [
  "bg",
  "panel",
  "card",
  "card-hover",
  "popover",
  "muted",
  "secondary",
  "hover",
  "line-1",
  "line-2",
  "line-3",
  "ink",
  "ink-2",
  "ink-3",
  "icon",
  "placeholder",
  "accent",
  "accent-ink",
  "on-accent",
  "inverse",
  "on-inverse",
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

export type SidebarSection = {
  readonly id: string
  readonly title: string
  readonly component: Component<{ host: Host }>
  readonly order?: number
}

export type PaneTab = {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly component: Component<{ host: Host; conversation: PaneConversation | undefined }>
  readonly order?: number
}

export type ComposerAction = {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly run: (host: Host, composer: ComposerHandle) => void
}

export type MessageRenderer = {
  readonly tool: string
  readonly component: Component<{ host: Host; call: RenderedCall }>
}

export type PaletteCommand = {
  readonly id: string
  readonly title: string
  readonly keywords?: readonly string[]
  readonly shortcut?: string
  readonly run: (host: Host) => void
}

export type SettingsPage = {
  readonly id: string
  readonly title: string
  readonly component: Component<{ host: Host }>
}

export type Theme = {
  readonly id: string
  readonly label: string
  readonly scheme: "dark" | "light"
  readonly tokens: ThemeTokens
}

export type SlotMap = {
  readonly "sidebar.section": SidebarSection
  readonly "pane.tab": PaneTab
  readonly "composer.action": ComposerAction
  readonly "message.renderer": MessageRenderer
  readonly "palette.command": PaletteCommand
  readonly "settings.page": SettingsPage
  readonly theme: Theme
}

export type SlotName = keyof SlotMap

export type PluginDef = {
  readonly name: string
  readonly slots: Partial<{ readonly [K in SlotName]: readonly SlotMap[K][] }>
}

export type ClientEntry = {
  readonly name: string
  readonly rows: readonly string[]
  readonly load: () => Promise<{ readonly default: PluginDef }>
}

export function definePlugin<const T extends PluginDef>(def: T): T {
  return def
}
