// Ported from dither-kit (https://github.com/Boring-Software-Inc/dither-kit, registry/dither-kit/dither-paint.ts and pixel.ts), MIT, Copyright (c) Boring Software Inc. See plugins/visual/LICENSE-dither-kit.

import type { Bloom, DitherVariant } from "../runtime/style.ts"

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => (value + 0.5) / 16))

const CELL = 2
const MAX_COLS = 960
const MAX_ROWS = 600
const BORDER_ALPHA = 0.72
const OFF_TIER = 0.4

type Rgba = readonly [number, number, number, number]

/** A cols × rows RGBA buffer the painters write into, put on the canvas in one call. */
export type Pixels = { readonly cols: number; readonly rows: number; readonly data: Uint8ClampedArray }

const threshold = (x: number, y: number): number => BAYER[y & 3]?.[x & 3] ?? 0.5
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const resolved = new Map<string, Rgba>()

/** Resolve any CSS colour (tokens arrive as `color-mix(...)` or `oklch(...)`) to RGBA through a 1×1 canvas, once per colour. */
function rgba(color: string): Rgba {
  const known = resolved.get(color)
  if (known !== undefined) return known
  const probe = document.createElement("canvas")
  probe.width = 1
  probe.height = 1
  const context = probe.getContext("2d", { willReadFrequently: true })
  if (context === null) return [0, 0, 0, 0]
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data
  const value: Rgba = [r, g, b, a / 255]
  resolved.set(color, value)
  return value
}

/** Composite one cell of `color` at `alpha` over what the buffer already holds (source-over, straight alpha). */
function blend(pixels: Pixels, x: number, y: number, color: Rgba, alpha: number): void {
  if (x < 0 || y < 0 || x >= pixels.cols || y >= pixels.rows) return
  const source = color[3] * alpha
  if (source <= 0) return
  const at = (y * pixels.cols + x) * 4
  const data = pixels.data
  const below = (data[at + 3] ?? 0) / 255
  const out = source + below * (1 - source)
  const mix = (channel: number, offset: number): number =>
    (channel * source + (data[at + offset] ?? 0) * below * (1 - source)) / out
  data[at] = mix(color[0], 0)
  data[at + 1] = mix(color[1], 1)
  data[at + 2] = mix(color[2], 2)
  data[at + 3] = out * 255
}

/**
 * Dither one lane of a bar or area band, dense at `base` and dissolving toward `tip`, capped by a soft edge, along either axis and in either direction.
 * `lane` indexes cells across the band and `tip`/`base` are cell coordinates along it.
 * Every cell is the one colour at a varying alpha rather than lighter shades of it, so the fade reads on light and dark grounds alike.
 */
export function paintStrip(
  pixels: Pixels,
  axis: "vertical" | "horizontal",
  lane: number,
  tip: number,
  base: number,
  color: string,
  options: { readonly variant: DitherVariant; readonly dim: number },
): void {
  const rgb = rgba(color)
  const forward = axis === "vertical" ? tip <= base : tip < base
  const from = Math.round(forward ? tip : (axis === "vertical" ? pixels.rows : pixels.cols) - tip)
  const to = Math.round(forward ? base : (axis === "vertical" ? pixels.rows : pixels.cols) - base)
  const plot = (along: number, alpha: number): void => {
    const position = forward ? along : (axis === "vertical" ? pixels.rows : pixels.cols) - along - 1
    if (axis === "vertical") blend(pixels, lane, position, rgb, alpha)
    else blend(pixels, position, lane, rgb, alpha)
  }
  const { variant, dim } = options
  const depth = to - from
  if (depth <= 0) {
    plot(from, BORDER_ALPHA * dim)
    return
  }
  const bias = variant === "dotted" ? 0.12 : 0
  for (let along = from; along < to; along += 1) {
    const density = (along - from) / depth
    if (variant === "hatched" && ((lane + along) & 3) >= 2) continue
    const lit = variant === "solid" || density > threshold(lane, along) - bias
    if (variant === "dotted" && !lit) continue
    const strength = 0.3 + density * 0.7
    plot(along, clamp01((lit ? strength : strength * OFF_TIER) * dim))
  }
  plot(from, BORDER_ALPHA * dim)
  if (depth > 1) plot(from + 1, BORDER_ALPHA * 0.5 * dim)
}

const BLOOM: Record<Exclude<Bloom, "off">, { blur: number; brightness: number; opacity: number; saturate: number }> = {
  low: { blur: 3, brightness: 1.35, opacity: 0.7, saturate: 1.4 },
  high: { blur: 5, brightness: 1.5, opacity: 0.78, saturate: 1.5 },
  aura: { blur: 15, brightness: 2.9, opacity: 0.1, saturate: 3 },
}

export type DitherLayer = {
  readonly element: HTMLDivElement
  /** Size the layer to a box in CSS px and paint it with one `putImageData`; a repeat with the same `key` does nothing. */
  readonly paint: (width: number, height: number, key: string, draw: (pixels: Pixels) => void) => void
}

/**
 * A crisp low-resolution canvas scaled up pixelated, with an optional bloom: a blurred copy composited `plus-lighter`, so each colour glows in its own hue.
 * The element fills its nearest positioned ancestor and takes no pointer events.
 */
export function ditherLayer(bloom: Bloom): DitherLayer {
  const element = document.createElement("div")
  element.setAttribute("aria-hidden", "true")
  element.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden"
  const crisp = document.createElement("canvas")
  crisp.style.cssText = "position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated"
  element.append(crisp)
  const glow = bloom === "off" ? undefined : BLOOM[bloom]
  const halo = glow === undefined ? undefined : document.createElement("canvas")
  if (glow !== undefined && halo !== undefined) {
    halo.style.cssText = `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:plus-lighter;opacity:${glow.opacity};filter:blur(${glow.blur}px) brightness(${glow.brightness}) saturate(${glow.saturate})`
    element.append(halo)
  }
  let painted: string | undefined
  return {
    element,
    paint: (width, height, key, draw) => {
      const cols = Math.min(MAX_COLS, Math.max(4, Math.round(width / CELL)))
      const rows = Math.min(MAX_ROWS, Math.max(4, Math.round(height / CELL)))
      const full = `${cols}x${rows}|${key}`
      if (full === painted) return
      painted = full
      const context = crisp.getContext("2d")
      if (context === null) return
      const image = new ImageData(cols, rows)
      draw({ cols, rows, data: image.data })
      crisp.width = cols
      crisp.height = rows
      context.putImageData(image, 0, 0)
      if (halo === undefined) return
      halo.width = cols
      halo.height = rows
      halo.getContext("2d")?.drawImage(crisp, 0, 0)
    },
  }
}
