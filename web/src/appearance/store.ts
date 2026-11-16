import { createEffect, createRoot, createSignal, on } from "solid-js"
import { cmd, OpError } from "../lib/api.ts"
import { theme } from "../lib/theme.ts"
import { applyTheme, themes } from "../plugins/slots.tsx"
import {
  CUSTOM_PREFIX,
  customId,
  DEFAULT_APPEARANCE,
  DIFF,
  INGLE_DARK,
  INGLE_LIGHT,
  ROSE,
  parseAppearance,
  tokensOf,
  variantOf,
  type Appearance,
  type CustomTheme,
  type Palette,
  type Variant,
} from "./model.ts"

const KEY = "ingle.appearance"
const SAVE_DELAY_MS = 700
const TEXT_TOKENS: readonly (readonly [string, number])[] = [
  ["--text-2xs", 11],
  ["--text-xs", 12],
  ["--text-sm", 13],
  ["--text-base", 14],
  ["--text-lg", 16],
  ["--text-xl", 20],
  ["--text-2xl", 24],
  ["--text-micro", 11],
  ["--text-mini", 12],
  ["--text-small", 13],
  ["--text-body", 14],
  ["--text-reading", 15],
  ["--text-title-mini", 16],
  ["--text-title-sm", 18],
  ["--text-title", 24],
  ["--text-title-lg", 28],
]

const LEGACY_THEME_KEY = "ingle.theme"

/** The saved document, or on the first load after upgrading, the theme the old picker stored. */
function stored(): Appearance {
  const saved = localStorage.getItem(KEY)
  if (saved !== null) {
    try {
      return parseAppearance(JSON.parse(saved))
    } catch {
      return DEFAULT_APPEARANCE
    }
  }
  const legacy = localStorage.getItem(LEGACY_THEME_KEY)
  if (legacy === null || legacy === "dark") return DEFAULT_APPEARANCE
  return parseAppearance(legacy === "light" ? { ...DEFAULT_APPEARANCE, mode: "light" } : { ...DEFAULT_APPEARANCE, theme: legacy })
}

const [appearance_, setAppearance_] = createSignal<Appearance>(stored())
const [systemDark, setSystemDark] = createSignal(window.matchMedia("(prefers-color-scheme: dark)").matches)
const [saving, setSaving] = createSignal<"idle" | "saving" | "saved" | "failed">("idle")
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => setSystemDark(event.matches))

export const appearance = appearance_
export const saveState = saving
export const variant = (): Variant => variantOf(appearance_().mode, systemDark())

type Change = (current: Appearance) => Appearance
type Home = { readonly doc: string | null; readonly rev: number }

let home: { readonly rev: number; readonly doc: Appearance | undefined } | undefined
let pending: readonly Change[] = []
let timer: ReturnType<typeof setTimeout> | undefined
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("ingle.appearance")

function show(next: Appearance): void {
  setAppearance_(next)
  localStorage.setItem(KEY, JSON.stringify(next))
}

const replay = (onto: Appearance, changes: readonly Change[]): Appearance =>
  changes.reduce((doc, change) => parseAppearance(change(doc)), onto)

async function readHome(): Promise<NonNullable<typeof home>> {
  const reply = await cmd<Home>("appearance.read")
  home = { rev: reply.rev, doc: reply.doc === null ? undefined : parseAppearance(JSON.parse(reply.doc)) }
  return home
}

/**
 * Saves the edits made since the home's copy was last seen, replayed on top of that copy, so an edit
 * never overwrites newer settings from another tab or device. A save that lost the race re-reads and replays.
 */
async function pushRemote(): Promise<void> {
  if (appearance_().sync !== "synced") {
    pending = []
    return
  }
  setSaving("saving")
  try {
    for (let attempt = 0; ; attempt += 1) {
      const known = home ?? (await readHome())
      const included = pending
      const next = known.doc === undefined ? appearance_() : replay(known.doc, included)
      try {
        const reply = await cmd<{ readonly rev: number }>("appearance.set", { doc: JSON.stringify(next), rev: known.rev })
        home = { rev: reply.rev, doc: next }
        pending = pending.slice(included.length)
        show(replay(next, pending))
        channel?.postMessage({ kind: "saved", rev: reply.rev, doc: next })
        setSaving("saved")
        return
      } catch (problem) {
        if (!(problem instanceof OpError && problem.code === "busy") || attempt >= 2) throw problem
        home = undefined
      }
    }
  } catch {
    setSaving("failed")
  }
}

/** One write per settled burst of changes, so a slider drag costs one row write. */
function schedule(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void pushRemote()
  }, SAVE_DELAY_MS)
}

export function update(change: Change): void {
  pending = [...pending, change]
  const next = parseAppearance(change(appearance_()))
  show(next)
  channel?.postMessage({ kind: "doc", doc: next })
  schedule()
}

/** The home's copy wins on load and on focus, with this tab's unsaved edits replayed on top, unless this device opted out of sync. */
export async function pullRemote(): Promise<void> {
  const known = await readHome().catch(() => undefined)
  if (known === undefined) return
  const local = appearance_()
  if (local.sync === "device") return
  if (known.doc === undefined) {
    if (local.sync === "synced" && JSON.stringify(local) !== JSON.stringify(DEFAULT_APPEARANCE)) schedule()
    return
  }
  const next = replay(known.doc, pending)
  if (JSON.stringify(next) !== JSON.stringify(local)) show(next)
}

channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data
  if (typeof data !== "object" || data === null || !("kind" in data) || !("doc" in data)) return
  const doc = parseAppearance(data.doc)
  if (data.kind === "saved" && "rev" in data && typeof data.rev === "number" && data.rev > (home?.rev ?? -1)) {
    home = { rev: data.rev, doc }
    setAppearance_(replay(doc, pending))
  }
  if (data.kind === "doc" && pending.length === 0) setAppearance_(doc)
})

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void pullRemote()
})

export function selectTheme(id: string): void {
  update((current) => ({ ...current, theme: id }))
}

export function saveCustomTheme(next: CustomTheme): void {
  update((current) => ({
    ...current,
    custom: current.custom.some((entry) => entry.id === next.id)
      ? current.custom.map((entry) => (entry.id === next.id ? next : entry))
      : [...current.custom, next],
  }))
}

export function deleteCustomTheme(id: string): void {
  update((current) => ({
    ...current,
    theme: current.theme === `${CUSTOM_PREFIX}${id}` ? DEFAULT_APPEARANCE.theme : current.theme,
    custom: current.custom.filter((entry) => entry.id !== id),
  }))
}

export function newThemeId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "theme"
  return `${slug}-${crypto.randomUUID().slice(0, 6)}`
}

/** Both palettes of a theme, so the mode thumbnails and "Create theme" start from what the theme really looks like. */
export function palettesOf(id: string): { readonly dark: Palette; readonly light: Palette } {
  const custom = appearance_().custom.find((entry) => `${CUSTOM_PREFIX}${entry.id}` === id)
  if (custom !== undefined) return { dark: custom.dark, light: custom.light }
  if (id === "rose") return { dark: ROSE, light: ROSE }
  const plugin = themes().find((entry) => entry.id === id && entry.id !== "dark" && entry.id !== "light")
  if (plugin === undefined) return { dark: INGLE_DARK, light: INGLE_LIGHT }
  const palette: Palette = {
    accent: plugin.tokens["accent"] ?? INGLE_DARK.accent,
    background: plugin.tokens["bg"] ?? INGLE_DARK.background,
    foreground: plugin.tokens["ink"] ?? INGLE_DARK.foreground,
  }
  return { dark: palette, light: palette }
}

const sheet = document.createElement("style")
sheet.id = "ingle-appearance"
document.head.append(sheet)

function paint(next: Appearance, wanted: Variant): void {
  const root = document.documentElement
  const id = customId(next.theme)
  const custom = id === undefined ? undefined : next.custom.find((entry) => entry.id === id)
  const rules: string[] = []
  if (custom !== undefined) {
    const tokens = tokensOf(wanted === "dark" ? custom.dark : custom.light, wanted)
    rules.push(Object.entries(tokens).map(([token, value]) => `--color-${token}: ${value};`).join(""))
  }
  const diff = DIFF[next.ui.diffColors]
  if (diff !== undefined) rules.push(`--color-diff-add: ${diff.add}; --color-diff-del: ${diff.del};`)
  const scale = next.ui.textScale / 100
  if (scale !== 1) rules.push(TEXT_TOKENS.map(([token, px]) => `${token}: ${Math.round(px * scale * 2) / 2}px;`).join(""))
  rules.push(`--w-sidebar: ${next.ui.sidebar}px; --w-pane: ${next.ui.pane}px;`)
  rules.push(`--appearance-input-opacity: ${next.background.input / 100};`)
  sheet.textContent = `:root:root { ${rules.join(" ")} }`
  if (next.ui.density === "auto") delete root.dataset.density
  else root.dataset.density = next.ui.density
  if (next.ui.codeSize === "default") delete root.dataset.codeSize
  else root.dataset.codeSize = next.ui.codeSize
  root.style.colorScheme = wanted
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", getComputedStyle(root).getPropertyValue("--color-bg").trim())
}

/** The registry id that sets the scheme attribute; a custom theme rides on the built-in theme of its variant. */
function registryId(next: Appearance, wanted: Variant): string {
  if (next.theme === "ingle" || customId(next.theme) !== undefined) return wanted
  return themes().some((entry) => entry.id === next.theme) ? next.theme : wanted
}

createRoot(() => {
  createEffect(() => {
    const next = appearance_()
    const wanted = variant()
    const id = registryId(next, wanted)
    if (theme() !== id) applyTheme(id)
    paint(next, wanted)
  })
  createEffect(
    on(
      theme,
      (picked) => {
        const expected = registryId(appearance_(), variant())
        if (picked === expected) return
        update((current) =>
          picked === "dark" || picked === "light" ? { ...current, mode: picked, theme: "ingle" } : { ...current, theme: picked },
        )
      },
      { defer: true },
    ),
  )
})
