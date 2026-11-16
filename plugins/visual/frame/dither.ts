const SVG = "http://www.w3.org/2000/svg"

/** The 8×8 Bayer matrix and 4px cell of Ingle's Appearance dither (web/src/appearance/render.ts), so visuals and backgrounds share one dot pattern. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54,
  22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29,
  53, 21,
]
export const DITHER_CELL = 4
export const DITHER_LEVELS = 8
const TILE = DITHER_CELL * 8

/** A pattern of Bayer dots in one colour at a density from 1 (sparse) to DITHER_LEVELS (solid dots). */
export function ditherPattern(id: string, color: string, level: number): SVGPatternElement {
  const pattern = document.createElementNS(SVG, "pattern")
  pattern.setAttribute("id", id)
  pattern.setAttribute("patternUnits", "userSpaceOnUse")
  pattern.setAttribute("width", String(TILE))
  pattern.setAttribute("height", String(TILE))
  const limit = (64 * level) / DITHER_LEVELS
  BAYER.forEach((threshold, index) => {
    if (threshold >= limit) return
    const dot = document.createElementNS(SVG, "rect")
    dot.setAttribute("x", String((index % 8) * DITHER_CELL + 0.5))
    dot.setAttribute("y", String(Math.floor(index / 8) * DITHER_CELL + 0.5))
    dot.setAttribute("width", String(DITHER_CELL - 1.5))
    dot.setAttribute("height", String(DITHER_CELL - 1.5))
    dot.setAttribute("fill", color)
    pattern.append(dot)
  })
  return pattern
}

/** Split a bar's length into equal steps whose density ramps from sparse at the base to dense at the tip. */
export function ditherSteps(
  length: number,
): readonly { readonly from: number; readonly to: number; readonly level: number }[] {
  const steps = Math.max(1, Math.min(DITHER_LEVELS, Math.round(length / TILE)))
  return Array.from({ length: steps }, (_, index) => ({
    from: (length * index) / steps,
    to: (length * (index + 1)) / steps,
    level: Math.round(2 + ((DITHER_LEVELS - 2) * (index + 1)) / steps),
  }))
}
