import { createEffect, createRoot, createSignal, onCleanup, type Accessor } from "solid-js"
import { Puzzle } from "lucide-solid"
import { cmd } from "../lib/api.ts"
import { BUILT_IN_THEMES, DEFAULT_THEME, paintTheme, setTheme, theme, type ThemeChoice } from "../lib/theme.ts"
import { navigate } from "../lib/router.ts"
import { CLIENT_PLUGINS } from "../plugins.gen.ts"
import { homeLoaded, homePlugins } from "../state/home.ts"
import { showToast } from "../state/toasts.ts"
import {
  THEME_TOKENS,
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

/** Each client module loads on its own: one that throws at import is logged and left out, and the others still load. */
for (const entry of CLIENT_PLUGINS)
  entry.load().then(
    (module) => setLoaded((current) => new Map([...current, [entry.name, module.default]])),
    (error: unknown) => console.error(`plugin ${entry.name} failed to load`, error),
  )

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
    (entry.plugin.slots[slot] ?? []).map((registration) => decorate(entry.name, registration)),
  )
  return items.sort((left, right) => orderOf(left) - orderOf(right))
}

export function slotItems<K extends SlotName>(slot: K): Accessor<readonly SlotItem<K>[]> {
  return () => itemsOf(enabled(), slot)
}

export function rendererFor(tool: string): SlotItem<"message.renderer"> | undefined {
  return itemsOf(enabled(), "message.renderer").find((item) => item.tool === tool)
}

const KNOWN_TOKENS: ReadonlySet<string> = new Set(THEME_TOKENS)

function choiceOf(registration: Theme): ThemeChoice {
  const tokens = Object.fromEntries(
    Object.entries(registration.tokens).filter(
      (pair): pair is [string, string] => KNOWN_TOKENS.has(pair[0]) && typeof pair[1] === "string",
    ),
  )
  return { id: registration.id, label: registration.label, scheme: registration.scheme, tokens }
}

export function themes(): readonly ThemeChoice[] {
  return [...BUILT_IN_THEMES, ...itemsOf(enabled(), "theme").map(choiceOf)]
}

export function applyTheme(id: string): void {
  setTheme(themes().find((entry) => entry.id === id) ?? DEFAULT_THEME)
}

createRoot(() => {
  createEffect(() => {
    const wanted = theme()
    const pool = homeLoaded() ? themes() : [...BUILT_IN_THEMES, ...itemsOf(loadedOf(CLIENT_PLUGINS), "theme").map(choiceOf)]
    paintTheme(pool.find((entry) => entry.id === wanted) ?? DEFAULT_THEME)
  })
})
