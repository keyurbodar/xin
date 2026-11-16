import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { contrast, mix, parseColor, type Rgb } from "../appearance/color.ts"
import { bayerThreshold, HALFTONE_ALPHA, HALFTONE_STYLE, halftoneDots, halftoneSvg } from "./halftone.ts"

test("the Bayer thresholds cover every level once per 8×8 period and repeat after it", () => {
  const levels = Array.from({ length: 64 }, (_, at) => bayerThreshold(at % 8, Math.floor(at / 8)) * 64 - 0.5)
  expect([...levels].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, at) => at))
  expect(bayerThreshold(9, 3)).toBe(bayerThreshold(1, 3))
  expect(bayerThreshold(0, 0)).toBe(0.5 / 64)
})

test("dots shrink as their cell's threshold rises and centre in their cells", () => {
  const dots = halftoneDots(4, 0.5)
  const at = (x: number, y: number) => dots.find((dot) => dot.x === x * 4 + 2 && dot.y === y * 4 + 2)?.r ?? 0
  expect(at(0, 0)).toBeGreaterThan(at(2, 0))
  expect(at(2, 0)).toBeGreaterThan(at(1, 0))
  expect(at(0, 7)).toBe(0)
  expect(Math.max(...dots.map((dot) => dot.r))).toBeLessThanOrEqual(4 * 0.46)
})

test("coverage thins the pattern from empty to a full field", () => {
  expect(halftoneDots(4, 0)).toHaveLength(0)
  expect(halftoneDots(4, 0.1).length).toBeGreaterThan(0)
  expect(halftoneDots(4, 0.1).length).toBeLessThan(halftoneDots(4, 0.3).length)
  expect(halftoneDots(4, 1)).toHaveLength(64)
})

test("the tile is one seamless 8-cell square svg, encoded once for the css mask", () => {
  const svg = halftoneSvg(4, 0.5)
  expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">')
  expect(svg.match(/<circle /gu)).toHaveLength(halftoneDots(4, 0.5).length)
  expect(HALFTONE_STYLE["--halftone"]).toBe(`url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
  expect(HALFTONE_STYLE["--halftone-size"]).toBe("32px")
})

const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8")

function theme(selector: string): Record<string, Rgb> {
  const start = tokens.indexOf(selector)
  const body = tokens.slice(start, tokens.indexOf("\n}", start))
  const colours: Record<string, Rgb> = {}
  for (const [, name, value] of body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]+);/giu)) {
    const colour = parseColor(value ?? "")
    if (name !== undefined && colour !== undefined) colours[name] = colour
  }
  return colours
}

const dark = theme("@theme {")
const themes: readonly (readonly [string, Record<string, Rgb>, number])[] = [
  ["dark", dark, 0.2],
  ["light", { ...dark, ...theme('[data-theme="light"]') }, 0.1],
  ["rose", { ...dark, ...theme('[data-theme="rose"]') }, 0.2],
]

test.each(themes)("text on a halftone card keeps AA contrast where a dot is solid (%s)", (_, colours, soft) => {
  const colour = (name: string): Rgb => colours[name] ?? { r: 0, g: 0, b: 0, a: 1 }
  const provider = mix(colour("panel"), colour("accent"), HALFTONE_ALPHA)
  const example = mix(mix(colour("card"), colour("accent"), soft), colour("accent"), HALFTONE_ALPHA)
  expect(contrast(colour("ink"), provider)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(colour("ink-2"), provider)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(colour("accent-ink"), example)).toBeGreaterThanOrEqual(4.5)
})
