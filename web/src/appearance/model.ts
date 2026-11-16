import { contrast, ensureContrast, isHex, mix, parseColor, readableOn, toHex, type Rgb } from "./color.ts"

export type Mode = "system" | "light" | "dark"
export type Sync = "synced" | "device"
export type Effect = "none" | "dither" | "grain" | "vignette"
export type Tone = "image" | "accent" | "mono"
export type Density = "auto" | "pointer" | "touch"
export type CodeSize = "small" | "default" | "large"
export type DiffColors = "red-green" | "blue-orange"
export type Variant = "light" | "dark"

/** The three colours a person picks; every other token is derived from them so contrast holds. */
export type Palette = { readonly accent: string; readonly background: string; readonly foreground: string }

export type CustomTheme = {
  readonly id: string
  readonly label: string
  readonly dark: Palette
  readonly light: Palette
  readonly background?: Background
}

export type Wallpaper = { readonly name: string; readonly url: string; readonly path?: string }

export type Background = {
  readonly image?: Wallpaper
  readonly effect: Effect
  readonly tone: Tone
  /** Dot pitch in CSS pixels for dither. */
  readonly cell: number
  readonly intensity: number
  readonly brightness: number
  readonly blur: number
  readonly opacity: number
  readonly fade: number
  readonly overlay: number
  readonly input: number
}

export type Interface = {
  readonly textScale: number
  readonly density: Density
  readonly sidebar: number
  readonly pane: number
  readonly codeSize: CodeSize
  readonly diffColors: DiffColors
}

export type Appearance = {
  readonly v: 1
  readonly mode: Mode
  readonly sync: Sync
  /** A built-in or plugin theme id, or `custom:<id>` for one of `custom`. */
  readonly theme: string
  readonly custom: readonly CustomTheme[]
  readonly background: Background
  readonly wallpapers: readonly Wallpaper[]
  readonly ui: Interface
}

export const DEFAULT_BACKGROUND: Background = {
  effect: "dither",
  tone: "image",
  cell: 4,
  intensity: 100,
  brightness: 100,
  blur: 0,
  opacity: 100,
  fade: 100,
  overlay: 0,
  input: 100,
}

export const DEFAULT_UI: Interface = {
  textScale: 100,
  density: "auto",
  sidebar: 240,
  pane: 432,
  codeSize: "default",
  diffColors: "red-green",
}

export const DEFAULT_APPEARANCE: Appearance = {
  v: 1,
  mode: "dark",
  sync: "synced",
  theme: "ingle",
  custom: [],
  background: DEFAULT_BACKGROUND,
  wallpapers: [],
  ui: DEFAULT_UI,
}

export const LIMITS = {
  textScale: [85, 125, 5],
  sidebar: [200, 320, 4],
  pane: [360, 560, 8],
  cell: [2, 10, 1],
  intensity: [0, 100, 1],
  brightness: [50, 150, 1],
  blur: [0, 24, 1],
  opacity: [0, 100, 1],
  fade: [0, 100, 1],
  overlay: [0, 90, 1],
  input: [40, 100, 1],
} as const satisfies Record<string, readonly [number, number, number]>

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : {}

const oneOf = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.find((choice) => choice === value) ?? fallback

const clamp = (value: unknown, [low, high]: readonly [number, number, number], fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined

const SHARE_PATH = /^\/s\/[\w-]+\/[^/?#]+$/u

function parseWallpaper(value: unknown): Wallpaper | undefined {
  const raw = record(value)
  const url = text(raw["url"], 2048)
  if (url === undefined || !(SHARE_PATH.test(url) || url.startsWith("data:image/"))) return undefined
  const path = text(raw["path"], 1024)
  return { name: text(raw["name"], 120) ?? "Wallpaper", url, ...(path === undefined ? {} : { path }) }
}

function parsePalette(value: unknown, fallback: Palette): Palette {
  const raw = record(value)
  const hex = (key: keyof Palette): string => {
    const found = raw[key]
    return typeof found === "string" && isHex(found) ? found.toLowerCase() : fallback[key]
  }
  return { accent: hex("accent"), background: hex("background"), foreground: hex("foreground") }
}

export function parseBackground(value: unknown): Background {
  const raw = record(value)
  const image = parseWallpaper(raw["image"])
  return {
    ...(image === undefined ? {} : { image }),
    effect: oneOf(raw["effect"], ["none", "dither", "grain", "vignette"], DEFAULT_BACKGROUND.effect),
    tone: oneOf(raw["tone"], ["image", "accent", "mono"], DEFAULT_BACKGROUND.tone),
    cell: clamp(raw["cell"], LIMITS.cell, DEFAULT_BACKGROUND.cell),
    intensity: clamp(raw["intensity"], LIMITS.intensity, DEFAULT_BACKGROUND.intensity),
    brightness: clamp(raw["brightness"], LIMITS.brightness, DEFAULT_BACKGROUND.brightness),
    blur: clamp(raw["blur"], LIMITS.blur, DEFAULT_BACKGROUND.blur),
    opacity: clamp(raw["opacity"], LIMITS.opacity, DEFAULT_BACKGROUND.opacity),
    fade: clamp(raw["fade"], LIMITS.fade, DEFAULT_BACKGROUND.fade),
    overlay: clamp(raw["overlay"], LIMITS.overlay, DEFAULT_BACKGROUND.overlay),
    input: clamp(raw["input"], LIMITS.input, DEFAULT_BACKGROUND.input),
  }
}

export const INGLE_DARK: Palette = { accent: "#3168f2", background: "#0a0a0b", foreground: "#ececed" }
export const ROSE: Palette = { accent: "#d3768a", background: "#0c0809", foreground: "#efe6e8" }
export const INGLE_LIGHT: Palette = { accent: "#2e61eb", background: "#f3f4f6", foreground: "#1c1c1e" }

export function parseCustomTheme(value: unknown): CustomTheme | undefined {
  const raw = record(value)
  const id = text(raw["id"], 64)
  const label = text(raw["label"], 48)
  if (id === undefined || label === undefined || !/^[\w-]+$/u.test(id)) return undefined
  const background = raw["background"] === undefined ? undefined : parseBackground(raw["background"])
  return {
    id,
    label,
    dark: parsePalette(raw["dark"], INGLE_DARK),
    light: parsePalette(raw["light"], INGLE_LIGHT),
    ...(background === undefined ? {} : { background }),
  }
}

export function parseAppearance(value: unknown): Appearance {
  const raw = record(value)
  const ui = record(raw["ui"])
  const custom = Array.isArray(raw["custom"])
    ? raw["custom"].flatMap((entry) => parseCustomTheme(entry) ?? []).slice(0, 40)
    : []
  const wallpapers = Array.isArray(raw["wallpapers"])
    ? raw["wallpapers"].flatMap((entry) => parseWallpaper(entry) ?? []).slice(0, 24)
    : []
  return {
    v: 1,
    mode: oneOf(raw["mode"], ["system", "light", "dark"], DEFAULT_APPEARANCE.mode),
    sync: oneOf(raw["sync"], ["synced", "device"], DEFAULT_APPEARANCE.sync),
    theme: text(raw["theme"], 80) ?? DEFAULT_APPEARANCE.theme,
    custom,
    background: parseBackground(raw["background"]),
    wallpapers,
    ui: {
      textScale: clamp(ui["textScale"], LIMITS.textScale, DEFAULT_UI.textScale),
      density: oneOf(ui["density"], ["auto", "pointer", "touch"], DEFAULT_UI.density),
      sidebar: clamp(ui["sidebar"], LIMITS.sidebar, DEFAULT_UI.sidebar),
      pane: clamp(ui["pane"], LIMITS.pane, DEFAULT_UI.pane),
      codeSize: oneOf(ui["codeSize"], ["small", "default", "large"], DEFAULT_UI.codeSize),
      diffColors: oneOf(ui["diffColors"], ["red-green", "blue-orange"], DEFAULT_UI.diffColors),
    },
  }
}

export type Tokens = Readonly<Record<string, string>>

const solid = (value: string): Rgb => parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 }

/** The full token set for a palette. Text roles are pushed until they pass WCAG AA on the background. */
export function tokensOf(palette: Palette, variant: Variant): Tokens {
  const bg = solid(palette.background)
  const fg = solid(palette.foreground)
  const accent = solid(palette.accent)
  const step = (amount: number): string => toHex(mix(bg, fg, amount))
  const ink = ensureContrast(fg, bg, 7)
  const accentInk = ensureContrast(mix(accent, fg, variant === "dark" ? 0.35 : 0.15), bg, 4.5)
  const veil = (amount: number): string => toHex({ ...fg, a: amount })
  return {
    bg: palette.background,
    panel: step(variant === "dark" ? 0.04 : 0.025),
    card: step(variant === "dark" ? 0.075 : 0),
    "card-hover": step(variant === "dark" ? 0.09 : 0.03),
    popover: step(variant === "dark" ? 0.075 : 0),
    muted: step(0.18),
    secondary: veil(0.07),
    hover: veil(0.1),
    "line-1": veil(0.075),
    "line-2": veil(0.11),
    "line-3": veil(0.15),
    ink: toHex(ink),
    "ink-2": toHex(ensureContrast(mix(bg, fg, 0.62), bg, 4.5)),
    "ink-3": toHex(ensureContrast(mix(bg, fg, 0.5), bg, 4.5)),
    icon: toHex(ensureContrast(mix(bg, fg, 0.38), bg, 3)),
    placeholder: toHex(ensureContrast(mix(bg, fg, 0.42), bg, 3)),
    accent: palette.accent,
    "accent-ink": toHex(accentInk),
    "on-accent": toHex(readableOn(accent)),
    inverse: toHex(ink),
    "on-inverse": palette.background,
  }
}

export type ContrastCheck = { readonly label: string; readonly ratio: number; readonly target: number }

/** What a person sees in the editor: the raw picks, before the derived tokens repair them. */
export function contrastChecks(palette: Palette): readonly ContrastCheck[] {
  const bg = solid(palette.background)
  const accent = solid(palette.accent)
  return [
    { label: "Text on background", ratio: contrast(solid(palette.foreground), bg), target: 7 },
    { label: "Button text on accent", ratio: contrast(readableOn(accent), accent), target: 4.5 },
    { label: "Accent against background", ratio: contrast(accent, bg), target: 3 },
  ]
}

export function variantOf(mode: Mode, systemDark: boolean): Variant {
  if (mode === "system") return systemDark ? "dark" : "light"
  return mode
}

export const DIFF: Readonly<Record<DiffColors, { readonly add: string; readonly del: string } | undefined>> = {
  "red-green": undefined,
  "blue-orange": { add: "#4b8fe8", del: "#e8913a" },
}

export const CUSTOM_PREFIX = "custom:"

export function customId(theme: string): string | undefined {
  return theme.startsWith(CUSTOM_PREFIX) ? theme.slice(CUSTOM_PREFIX.length) : undefined
}

/** The first document on a device that only has the old picker's theme id. */
export function fromLegacyTheme(id: string | null): Appearance {
  if (id === null || id === "dark") return DEFAULT_APPEARANCE
  return parseAppearance(id === "light" ? { ...DEFAULT_APPEARANCE, mode: "light" } : { ...DEFAULT_APPEARANCE, theme: id })
}

/** A theme picked outside Appearance, from the owner menu: Light and Dark are modes of Ingle's own theme. */
export function pickedInMenu(current: Appearance, picked: string): Appearance {
  return picked === "dark" || picked === "light" ? { ...current, mode: picked, theme: "ingle" } : { ...current, theme: picked }
}

/** Drops a wallpaper from the library, and from the background when it is the one in use. */
export function withoutWallpaper(current: Appearance, url: string): Appearance {
  const { image, ...rest } = current.background
  return {
    ...current,
    background: image?.url === url ? rest : current.background,
    wallpapers: current.wallpapers.filter((entry) => entry.url !== url),
  }
}
