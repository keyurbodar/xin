// Ported from dither-kit (https://github.com/Boring-Software-Inc/dither-kit, registry/dither-kit/dither-paint.ts, pixel.ts and gradient.tsx), MIT, Copyright (c) Boring Software Inc. See plugins/visual/LICENSE-dither-kit.

import type { Bloom, DitherVariant } from "../runtime/style.ts"

/** The 4×4 ordered (Bayer) matrix as 0–1 thresholds. */
export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16))

export const DITHER_CELL = 2
const MAX_COLS = 960
const MAX_ROWS = 600
const BORDER_ALPHA = 0.72
const OFF_TIER = 0.4

export type { Bloom, DitherVariant }
export type WashDirection = "up" | "down" | "left" | "right"

/** What the painters need from a 2D context, so they run against a recording fake in tests. */
export type Cells = Pick<CanvasRenderingContext2D, "fillStyle" | "globalAlpha" | "fillRect">

const threshold = (x: number, y: number): number => BAYER[y & 3]?.[x & 3] ?? 0.5
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function cell(target: Cells, x: number, y: number, alpha: number): void {
  target.globalAlpha = alpha
  target.fillRect(x, y, 1, 1)
}

/**
 * Fill cell column `x` from row `top` down to `floor`: dense at the floor, dissolving toward `top`, capped by a soft edge.
 * Every cell is the one colour at a varying alpha rather than lighter shades of it, so the fade reads on light and dark grounds alike.
 */
export function paintColumn(
  target: Cells,
  x: number,
  top: number,
  floor: number,
  color: string,
  options: { readonly variant: DitherVariant; readonly dim: number },
): void {
  const { variant, dim } = options
  const from = Math.round(top)
  const to = Math.round(floor)
  const depth = to - from
  target.fillStyle = color
  if (depth <= 0) {
    cell(target, x, from, BORDER_ALPHA * dim)
    return
  }
  const bias = variant === "dotted" ? 0.12 : 0
  for (let y = from; y < to; y += 1) {
    const density = (y - from) / depth
    if (variant === "hatched" && ((x + y) & 3) >= 2) continue
    const lit = variant === "solid" || density > threshold(x, y) - bias
    if (variant === "dotted" && !lit) continue
    const strength = 0.3 + density * 0.7
    cell(target, x, y, clamp01((lit ? strength : strength * OFF_TIER) * dim))
  }
  cell(target, x, from, BORDER_ALPHA * dim)
  if (depth > 1) cell(target, x, from + 1, BORDER_ALPHA * 0.5 * dim)
}

/** A dithered wash that is solid at the edge opposite `direction` and dissolves to transparent toward it. */
export function paintWash(
  target: Cells,
  cols: number,
  rows: number,
  color: string,
  options: { readonly direction: WashDirection; readonly opacity: number },
): void {
  const { direction, opacity } = options
  target.fillStyle = color
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const toward =
        direction === "up"
          ? 1 - (y + 0.5) / rows
          : direction === "down"
            ? (y + 0.5) / rows
            : direction === "left"
              ? 1 - (x + 0.5) / cols
              : (x + 0.5) / cols
      const density = 1 - toward
      const alpha = (density > threshold(x, y) ? 0.35 + 0.65 * density : 0.12 * density) * opacity
      if (alpha > 0.004) cell(target, x, y, alpha)
    }
  }
}

const BLOOM: Record<Exclude<Bloom, "off">, { blur: number; brightness: number; opacity: number; saturate: number }> = {
  low: { blur: 3, brightness: 1.35, opacity: 0.7, saturate: 1.4 },
  high: { blur: 5, brightness: 1.5, opacity: 0.78, saturate: 1.5 },
  aura: { blur: 15, brightness: 2.9, opacity: 0.1, saturate: 3 },
}

export type DitherLayer = {
  readonly element: HTMLDivElement
  /** Size the layer to a box in CSS px and repaint it; `paint` draws in cell units on a cols × rows grid. */
  readonly paint: (
    width: number,
    height: number,
    draw: (context: CanvasRenderingContext2D, cols: number, rows: number) => void,
  ) => void
}

/**
 * A crisp low-resolution canvas scaled up pixelated, with an optional bloom: a blurred copy composited `plus-lighter`, so each colour glows in its own hue.
 * The element fills its nearest positioned ancestor and takes no pointer events.
 */
export function ditherLayer(options: { readonly bloom: Bloom; readonly cell?: number }): DitherLayer {
  const size = options.cell ?? DITHER_CELL
  const element = document.createElement("div")
  element.setAttribute("aria-hidden", "true")
  element.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden"
  const crisp = document.createElement("canvas")
  crisp.style.cssText = "position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated"
  element.append(crisp)
  const glow = options.bloom === "off" ? undefined : BLOOM[options.bloom]
  const halo = glow === undefined ? undefined : document.createElement("canvas")
  if (glow !== undefined && halo !== undefined) {
    halo.style.cssText = `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:plus-lighter;opacity:${glow.opacity};filter:blur(${glow.blur}px) brightness(${glow.brightness}) saturate(${glow.saturate})`
    element.append(halo)
  }
  return {
    element,
    paint: (width, height, draw) => {
      const cols = Math.min(MAX_COLS, Math.max(4, Math.round(width / size)))
      const rows = Math.min(MAX_ROWS, Math.max(4, Math.round(height / size)))
      crisp.width = cols
      crisp.height = rows
      const context = crisp.getContext("2d")
      if (context === null) return
      draw(context, cols, rows)
      context.globalAlpha = 1
      context.setTransform(1, 0, 0, 1, 0, 0)
      if (halo === undefined) return
      halo.width = cols
      halo.height = rows
      halo.getContext("2d")?.drawImage(crisp, 0, 0)
    },
  }
}

/**
 * Paint one lane of a bar or area band, dense at `base` and dissolving toward `tip`, along either axis and in either direction.
 * `lane` indexes cells across the band and `tip`/`base` are cell coordinates along it; the context is flipped so `paintColumn` always runs top-down.
 */
export function paintStrip(
  context: CanvasRenderingContext2D,
  grid: { readonly cols: number; readonly rows: number },
  axis: "vertical" | "horizontal",
  lane: number,
  tip: number,
  base: number,
  color: string,
  options: { readonly variant: DitherVariant; readonly dim: number },
): void {
  if (axis === "vertical" && tip <= base) paintColumn(context, lane, tip, base, color, options)
  else if (axis === "vertical") {
    context.setTransform(1, 0, 0, -1, 0, grid.rows)
    paintColumn(context, lane, grid.rows - tip, grid.rows - base, color, options)
  } else if (tip >= base) {
    context.setTransform(0, 1, -1, 0, grid.cols, 0)
    paintColumn(context, lane, grid.cols - tip, grid.cols - base, color, options)
  } else {
    context.setTransform(0, 1, 1, 0, 0, 0)
    paintColumn(context, lane, tip, base, color, options)
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
}
