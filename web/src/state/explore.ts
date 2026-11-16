import { cmd } from "../lib/api.ts"
import { isRecord, listOf, numOf, strOf } from "../lib/parse.ts"
import { remote, type RemoteHandle } from "./extensions.ts"
import type { Background, CustomTheme, Effect, Palette } from "../appearance/model.ts"

export type ExploreSkill = {
  readonly name: string
  readonly title: string
  readonly author: string
  readonly category: string
  readonly description: string
  readonly lines: number
}

export type ExploreTheme = {
  readonly id: string
  readonly label: string
  readonly author: string
  readonly category: string
  readonly description: string
  readonly scheme: "dark" | "light"
  readonly effect: Effect
  readonly dark: Palette
  readonly light: Palette
}

export type SkillEntry = ExploreSkill & { readonly markdown: string }

const records = (value: unknown): readonly Readonly<Record<string, unknown>>[] => listOf(value).filter(isRecord)

const entriesOf = (value: unknown): readonly Readonly<Record<string, unknown>>[] =>
  records(isRecord(value) ? value["entries"] : undefined)

const HEX = /^#[0-9a-f]{6}$/iu

function paletteOf(value: unknown): Palette | undefined {
  if (!isRecord(value)) return undefined
  const accent = strOf(value["accent"])
  const background = strOf(value["background"])
  const foreground = strOf(value["foreground"])
  if (accent === undefined || background === undefined || foreground === undefined) return undefined
  if (![accent, background, foreground].every((colour) => HEX.test(colour))) return undefined
  return { accent, background, foreground }
}

const EFFECTS: readonly Effect[] = ["none", "dither", "grain", "vignette"]

function themeOf(item: Readonly<Record<string, unknown>>): ExploreTheme | undefined {
  const id = strOf(item["id"])
  const dark = paletteOf(item["dark"])
  const light = paletteOf(item["light"])
  if (id === undefined || dark === undefined || light === undefined) return undefined
  return {
    id,
    label: strOf(item["label"]) ?? id,
    author: strOf(item["author"]) ?? "",
    category: strOf(item["category"]) ?? "Other",
    description: strOf(item["description"]) ?? "",
    scheme: item["scheme"] === "light" ? "light" : "dark",
    effect: EFFECTS.find((effect) => effect === item["effect"]) ?? "none",
    dark,
    light,
  }
}

function skillOf(item: Readonly<Record<string, unknown>>): ExploreSkill | undefined {
  const name = strOf(item["name"])
  if (name === undefined) return undefined
  return {
    name,
    title: strOf(item["title"]) ?? name,
    author: strOf(item["author"]) ?? "",
    category: strOf(item["category"]) ?? "Other",
    description: strOf(item["description"]) ?? "",
    lines: numOf(item["lines"]) ?? 0,
  }
}

export const exploreSkills: RemoteHandle<readonly ExploreSkill[]> = remote(
  () => cmd("explore.search", { kind: "skill" }),
  (value) => entriesOf(value).flatMap((item) => skillOf(item) ?? []),
)

export const exploreThemes: RemoteHandle<readonly ExploreTheme[]> = remote(
  () => cmd("explore.search", { kind: "theme" }),
  (value) => entriesOf(value).flatMap((item) => themeOf(item) ?? []),
)

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The same canonical form the explore plugin pins: keys sorted at every level, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

/** Fetches one entry and refuses it unless its content hashes to the sha256 the catalogue pinned. */
async function verifiedEntry(kind: "skill" | "theme", name: string): Promise<Readonly<Record<string, unknown>>> {
  const value = await cmd<unknown>("explore.entry", { kind, name })
  const entry = isRecord(value) ? value["entry"] : undefined
  const pinned = isRecord(value) ? strOf(value["sha256"]) : undefined
  if (!isRecord(entry) || pinned === undefined) throw new Error(`Explore returned no ${kind} ${name}`)
  const markdown = strOf(entry["markdown"])
  const actual = await sha256(kind === "skill" ? (markdown ?? "") : canonical(entry))
  if (actual !== pinned) throw new Error(`${name} failed its integrity check, so it was not added`)
  return entry
}

export async function skillEntry(name: string): Promise<SkillEntry> {
  const entry = await verifiedEntry("skill", name)
  const skill = skillOf(entry)
  const markdown = strOf(entry["markdown"])
  if (skill === undefined || markdown === undefined) throw new Error(`Explore returned a malformed skill ${name}`)
  return { ...skill, lines: markdown.split("\n").length, markdown }
}

export const themeSource = (id: string): string => `explore:${id}`

/** A copy for your themes; it keeps your wallpaper and settings and only switches the effect to the theme's. */
export async function catalogTheme(id: string, current: Background): Promise<CustomTheme> {
  const theme = themeOf(await verifiedEntry("theme", id))
  if (theme === undefined) throw new Error(`Explore returned a malformed theme ${id}`)
  return {
    id: theme.id,
    label: theme.label,
    source: themeSource(theme.id),
    dark: theme.dark,
    light: theme.light,
    background: { ...current, effect: theme.effect },
  }
}
