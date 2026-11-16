const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21]

export function bayerThreshold(x: number, y: number): number {
  return ((BAYER[(y % 8) * 8 + (x % 8)] ?? 0) + 0.5) / 64
}

export type Dot = { readonly x: number; readonly y: number; readonly r: number }

export function halftoneDots(cell: number, coverage: number): readonly Dot[] {
  const dots: Dot[] = []
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const level = Math.min(1, Math.max(0, coverage * 2 - bayerThreshold(x, y)))
      const r = cell * 0.46 * Math.sqrt(level)
      if (r < cell * 0.1) continue
      dots.push({ x: x * cell + cell / 2, y: y * cell + cell / 2, r: Math.round(r * 100) / 100 })
    }
  }
  return dots
}

export function halftoneSvg(cell: number, coverage: number): string {
  const size = cell * 8
  const circles = halftoneDots(cell, coverage)
    .map((dot) => `<circle cx="${dot.x}" cy="${dot.y}" r="${dot.r}"/>`)
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${circles}</svg>`
}

export const HALFTONE_ALPHA = 0.1

const CELL = 4

export const HALFTONE_STYLE = {
  "--halftone": `url("data:image/svg+xml,${encodeURIComponent(halftoneSvg(CELL, 0.5))}")`,
  "--halftone-size": `${CELL * 8}px`,
  "--halftone-alpha": String(HALFTONE_ALPHA),
}
