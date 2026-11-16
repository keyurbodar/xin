// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { type Color, TEXT_METRICS, type TextSize, type Token } from "../runtime/style.ts"
import type { FrameTheme } from "./protocol.ts"

export function cssColor(color: Color, theme: FrameTheme): string {
  const base = theme.colors[color.token]
  const mixed =
    color.mix === undefined
      ? base
      : `color-mix(in oklab, ${base} ${Math.round((1 - color.mix.t) * 1000) / 10}%, ${theme.colors[color.mix.token]})`
  return color.alpha >= 1 ? mixed : `color-mix(in oklab, ${mixed} ${Math.round(color.alpha * 1000) / 10}%, transparent)`
}

export const tokenCss = (token: Token, theme: FrameTheme): string => theme.colors[token]

export const FONT = `"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif`
export const MONO = `"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace`

export function fontOf(size: TextSize, weight: number, mono: boolean): string {
  const [px] = TEXT_METRICS[size]
  return `${weight} ${px}px ${mono ? MONO : FONT}`
}
