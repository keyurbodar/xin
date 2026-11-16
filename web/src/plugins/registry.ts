import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js"
import { Puzzle } from "lucide-solid"
import { cmd } from "../lib/api.ts"
import { BUILT_IN_THEMES, DEFAULT_THEME, paintTheme, setTheme, theme, type ThemeChoice } from "../lib/theme.ts"
import { navigate } from "../lib/router.ts"
import { CLIENT_PLUGINS } from "../plugins.gen.ts"
import { homeLoaded, homePlugins } from "../state/home.ts"
import { showToast } from "../state/toasts.ts"
import { loadEach, themeChoice } from "./isolate.ts"
import {
  type ClientEntry,
  type ComposerHandle,
  type Host,
  type PaneConversation,
  type PluginDef,
  type SlotMap,
  type SlotName,
  type Theme,
} from "./sdk.ts"

export type SlotItem<K extends SlotName> = SlotMap[K] & { readonly plugin: string; readonly key: string }

const [composer, setComposer] = createSignal<ComposerHandle | undefined>()
const [conversation, setConversation] = createSignal<PaneConversation | undefined>()
const [loaded, setLoaded] = createSignal<ReadonlyMap<string, PluginDef>>(new Map())

export const activeConversation = conversation

function toast(text: string): void {
  showToast({ icon: Puzzle, title: text, detail: undefined, expire: () => undefined })
}

void loadEach(CLIENT_PLUGINS, (name, plugin) => setLoaded((current) => new Map([...current, [name, plugin]])))

type Loaded = { readonly name: string; readonly plugin: PluginDef }

function loadedOf(entries: readonly ClientEntry[]): readonly Loaded[] {
  const modules = loaded()
  return entries.flatMap((entry) => {
    const plugin = modules.get(entry.name)
    return plugin === undefined ? [] : [{ name: entry.name, plugin }]
  })
}

export const host: Host = {
  cmd: <T>(op: string, args?: Record<string, unknown>) => cmd<T>(op, args),
  navigate,
  conversation: () => conversation()?.id,
  composer: {
    insert: (text) => (composer() ?? missingComposer()).insert(text),
    submit: (text) => (composer() ?? missingComposer()).submit(text),
  },
  toast,
}

function missingComposer(): ComposerHandle {
  const tell = (): void => toast("Open a conversation to use the composer")
  return { insert: tell, submit: tell }
}

export function bindComposer(handle: ComposerHandle): void {
  setComposer(() => handle)
  onCleanup(() => {
    if (composer() === handle) setComposer(undefined)
  })
}

export function bindConversation(view: Accessor<PaneConversation | undefined>): void {
  createEffect(() => setConversation(view()))
  onCleanup(() => setConversation(undefined))
}

function enabled(): readonly Loaded[] {
  const states = homePlugins()
  return loadedOf(CLIENT_PLUGINS.filter((entry) => entry.rows.some((row) => states[row] === "active")))
}

function keyOf(registration: SlotMap[SlotName]): string {
  return "tool" in registration ? registration.tool : registration.id
}

function orderOf(registration: SlotMap[SlotName]): number {
  return "order" in registration ? (registration.order ?? 0) : 0
}

type Decorate<K extends SlotName> = (plugin: string, registration: SlotMap[K]) => SlotItem<K>

function decorator<K extends SlotName>(): Decorate<K> {
  const cache = new WeakMap<SlotMap[K], SlotItem<K>>()
  return (plugin, registration) => {
    const cached = cache.get(registration)
    if (cached !== undefined) return cached
    const item: SlotItem<K> = { ...registration, plugin, key: `${plugin}:${keyOf(registration)}` }
    cache.set(registration, item)
    return item
  }
}

const DECORATE: { readonly [K in SlotName]: Decorate<K> } = {
  "sidebar.section": decorator(),
  "pane.tab": decorator(),
  "composer.action": decorator(),
  "message.renderer": decorator(),
  "palette.command": decorator(),
  "settings.page": decorator(),
  theme: decorator(),
}

function itemsOf<K extends SlotName>(entries: readonly Loaded[], slot: K): readonly SlotItem<K>[] {
  const decorate: Decorate<K> = DECORATE[slot]
  const items = entries.flatMap((entry) =>
    (entry.plugin.slots[slot] ?? []).flatMap((registration: unknown) =>
      typeof registration === "object" && registration !== null
        ? [decorate(entry.name, registration as SlotMap[K])]
        : [],
    ),
  )
  return items.sort((left, right) => orderOf(left) - orderOf(right))
}

export function slotItems<K extends SlotName>(slot: K): Accessor<readonly SlotItem<K>[]> {
  return () => itemsOf(enabled(), slot)
}

export function rendererFor(tool: string): SlotItem<"message.renderer"> | undefined {
  return itemsOf(enabled(), "message.renderer").find((item) => item.tool === tool)
}

function choicesOf(entries: readonly Loaded[]): readonly ThemeChoice[] {
  return itemsOf(entries, "theme").flatMap((item) => themeChoice(item.plugin, item) ?? [])
}

export function themes(): readonly ThemeChoice[] {
  return [...BUILT_IN_THEMES, ...choicesOf(enabled())]
}

export function applyTheme(id: string): void {
  setTheme(themes().find((entry) => entry.id === id) ?? DEFAULT_THEME)
}

createRoot(() => {
  createEffect(() => {
    const wanted = theme()
    const pool = homeLoaded() ? themes() : [...BUILT_IN_THEMES, ...choicesOf(loadedOf(CLIENT_PLUGINS))]
    paintTheme(pool.find((entry) => entry.id === wanted) ?? DEFAULT_THEME)
  })
})
