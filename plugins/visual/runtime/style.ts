// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

export class VisualError extends Error {
  override readonly name = "VisualError"
}

export const TOKEN_NAMES = [
  "text",
  "muted",
  "faint",
  "accent",
  "on-accent",
  "success",
  "warning",
  "danger",
  "border",
  "chart1",
  "chart2",
  "chart3",
  "chart4",
  "chart5",
  "chart6",
] as const

export type Token = (typeof TOKEN_NAMES)[number]

const TOKENS: ReadonlySet<string> = new Set(TOKEN_NAMES)

export function parseToken(name: string): Token {
  if (TOKENS.has(name)) return name as Token
  throw new VisualError(
    `unknown color '${name}': colors are theme tokens (${TOKEN_NAMES.join(", ")}), so a visual reads in light and dark`,
  )
}

export function seriesToken(index: number): Token {
  return `chart${(index % 6) + 1}` as Token
}

export type Color = {
  readonly token: Token
  readonly mix?: { readonly token: Token; readonly t: number }
  readonly alpha: number
}

export const tokenColor = (token: Token): Color => ({ token, alpha: 1 })

export type TextSize = "xs" | "sm" | "body" | "lg" | "xl" | "2xl"

export function parseTextSize(name: string): TextSize {
  switch (name) {
    case "xs":
    case "sm":
    case "body":
    case "lg":
    case "xl":
    case "2xl":
      return name
    case "md":
    case "base":
      return "body"
    default:
      throw new VisualError(
        `unknown text size '${name}': use xs, sm, body, lg, xl, or 2xl (the transcript's type scale)`,
      )
  }
}

export const TEXT_METRICS: Readonly<Record<TextSize, readonly [number, number]>> = {
  xs: [11, 16],
  sm: [12, 18],
  body: [14, 22],
  lg: [15, 22],
  xl: [16, 24],
  "2xl": [19, 27],
}

export type Weight = 400 | 500 | 600 | 700

export function weightFromNumber(weight: number): Weight {
  if (weight < 450) return 400
  if (weight < 550) return 500
  if (weight < 650) return 600
  return 700
}

export function parseWeight(name: string): Weight {
  switch (name) {
    case "regular":
    case "normal":
      return 400
    case "medium":
      return 500
    case "semibold":
      return 600
    case "bold":
      return 700
    default:
      throw new VisualError(`unknown weight '${name}': use 400-700 or regular, medium, semibold, bold`)
  }
}

export type Align = "start" | "center" | "end"

export function parseAlign(name: string): Align {
  switch (name) {
    case "start":
    case "left":
    case "top":
      return "start"
    case "center":
    case "middle":
      return "center"
    case "end":
    case "right":
    case "bottom":
      return "end"
    default:
      throw new VisualError(`unknown alignment '${name}': use start, center, or end`)
  }
}

export type Justify = Align | "between"

export function parseJustify(name: string): Justify {
  return name === "between" || name === "space-between" ? "between" : parseAlign(name)
}

export const DITHER_VARIANTS = ["gradient", "dotted", "hatched", "solid"] as const
export type DitherVariant = (typeof DITHER_VARIANTS)[number]
export const BLOOMS = ["off", "low", "high", "aura"] as const
export type Bloom = (typeof BLOOMS)[number]

export type NumberFormat = { readonly prefix: string; readonly unit: string; readonly decimals: number | undefined }

export const PLAIN_FORMAT: NumberFormat = { prefix: "", unit: "", decimals: undefined }

export function formatNumber(format: NumberFormat, value: number): string {
  const magnitude = Math.abs(value)
  const decimals =
    format.decimals ?? (magnitude === 0 || magnitude >= 100 || Number.isInteger(value) ? 0 : magnitude >= 10 ? 1 : 2)
  const text = value.toFixed(decimals)
  const sign = text.startsWith("-") ? "-" : ""
  const digits = sign === "" ? text : text.slice(1)
  const [int = "", frac = ""] = digits.split(".")
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")
  const space = format.unit === "" || format.unit.startsWith("%") ? "" : " "
  return `${sign}${format.prefix}${grouped}${frac === "" ? "" : `.${frac}`}${space}${format.unit}`
}

export function niceTicks(low: number, high: number, count: number): number[] {
  const [lo, hi] = high < low ? [high, low] : [low, high]
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (Math.abs(hi - lo) < Number.EPSILON) return [lo]
  const raw = (hi - lo) / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = magnitude * (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10)
  const digits = 10 ** Math.max(0, -Math.floor(Math.log10(step)))
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && out.length < 100; v += step)
    out.push(Math.round(Math.round(v / step) * step * digits) / digits)
  return out
}
