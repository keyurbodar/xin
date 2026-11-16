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

function stored(): Appearance {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(KEY) ?? "{}"))
  } catch {
    return DEFAULT_APPEARANCE
  }
}

const [appearance_, setAppearance_] = createSignal<Appearance>(stored())
const [systemDark, setSystemDark] = createSignal(window.matchMedia("(prefers-color-scheme: dark)").matches)
const [saving, setSaving] = createSignal<"idle" | "saving" | "saved" | "failed">("idle")
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => setSystemDark(event.matches))

export const appearance = appearance_
export const saveState = saving
export const variant = (): Variant => variantOf(appearance_().mode, systemDark())

let rev: number | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("ingle.appearance")

function persistLocal(next: Appearance): void {
  localStorage.setItem(KEY, JSON.stringify(next))
}

async function pushRemote(): Promise<void> {
  const next = appearance_()
  if (next.sync !== "synced") return
  setSaving("saving")
  try {
    const reply = await cmd<{ readonly rev: number }>("appearance.set", {
      doc: JSON.stringify(next),
      ...(rev === undefined ? {} : { rev }),
    })
    rev = reply.rev
    setSaving("saved")
  } catch (problem) {
    if (problem instanceof OpError && problem.code === "busy") {
      rev = undefined
      await pullRemote()
      return
    }
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

export function update(change: (current: Appearance) => Appearance): void {
  const next = parseAppearance(change(appearance_()))
  setAppearance_(next)
  persistLocal(next)
  channel?.postMessage(next)
  schedule()
}

/** The home's copy wins on load and on focus, unless this device opted out of sync. */
export async function pullRemote(): Promise<void> {
  if (timer !== undefined) return
  try {
    const reply = await cmd<{ readonly doc: string | null; readonly rev: number }>("appearance.read")
    rev = reply.rev
    const local = appearance_()
    if (reply.doc === null) {
      if (local.sync === "synced" && JSON.stringify(local) !== JSON.stringify(DEFAULT_APPEARANCE)) schedule()
      return
    }
    const remote = parseAppearance(JSON.parse(reply.doc))
    if (local.sync === "device") {
      rev = reply.rev
      return
    }
    if (JSON.stringify(remote) === JSON.stringify(local)) return
    setAppearance_(remote)
    persistLocal(remote)
  } catch {
    return
  }
}

channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const next = parseAppearance(event.data)
  setAppearance_(next)
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

/** Explore's theme kind: adds a copy to your themes (once) and applies it with its background. */
export function addCatalogTheme(entry: CustomTheme): void {
  const known = appearance_().custom.find((theme) => theme.source !== undefined && theme.source === entry.source)
  const theme = known ?? { ...entry, id: newThemeId(entry.label) }
  update((current) => ({
    ...current,
    theme: `${CUSTOM_PREFIX}${theme.id}`,
    custom: known === undefined ? [...current.custom, theme] : current.custom,
    background: theme.background ?? current.background,
  }))
}

export function isCatalogThemeAdded(source: string): boolean {
  return appearance_().custom.some((theme) => theme.source === source)
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
        update((current) => ({ ...current, theme: picked === "dark" || picked === "light" ? "ingle" : picked }))
      },
      { defer: true },
    ),
  )
})
