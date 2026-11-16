import { expect, setDefaultTimeout, test } from "bun:test"
import type { Page } from "playwright"
import { startHarness } from "./harness.ts"

setDefaultTimeout(120_000)

const THEMES = ["dark", "light"] as const
const CONTROLS = ["button", "menu", "input", "switch"] as const
const SURFACES = ["background", "panel", "raised", "overlay", "hover", "selected"] as const

type Rgb = readonly [number, number, number]
type Ring = { control: string; surface: string; style: string; width: number; ring: Rgb; behind: Rgb }

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

const contrast = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

const focusedRing = (page: Page): Promise<Ring> =>
  page.evaluate(() => {
    const element = document.activeElement
    if (!(element instanceof HTMLElement)) throw new Error("nothing focused")
    if (!element.matches(":focus-visible")) throw new Error(`${element.tagName} is not :focus-visible`)
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (context === null) throw new Error("no 2d context")
    const paint = (colors: readonly string[]): [number, number, number] => {
      context.globalCompositeOperation = "source-over"
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, 1, 1)
      for (const color of colors) {
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
      }
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    const layers: string[] = []
    for (let node = element.parentElement; node !== null; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor)
    const style = getComputedStyle(element)
    const behind = paint(layers)
    return {
      control: element.closest("[data-control]")?.getAttribute("data-control") ?? element.tagName.toLowerCase(),
      surface: element.closest("[data-surface]")?.getAttribute("data-surface") ?? "none",
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      ring: paint([...layers, style.outlineColor]),
      behind,
    }
  })

test("the keyboard focus ring is at least 2px and 3:1 against every surface in both themes", async () => {
  const harness = await startHarness()
  try {
    for (const theme of THEMES) {
      const page = await harness.open("focus-ring", { search: `?theme=${theme}` })
      const seen = new Map<string, Ring>()
      for (let step = 0; step < CONTROLS.length * SURFACES.length; step++) {
        await page.keyboard.press("Tab")
        const ring = await focusedRing(page)
        seen.set(`${ring.surface}/${ring.control}`, ring)
      }
      await page.close()
      for (const surface of SURFACES) {
        for (const control of CONTROLS) {
          const ring = seen.get(`${surface}/${control}`)
          expect(ring, `${theme} ${surface} ${control} took keyboard focus`).toBeDefined()
          if (ring === undefined) continue
          const ratio = contrast(ring.ring, ring.behind)
          expect(ring.style, `${theme} ${surface} ${control} outline style`).toBe("solid")
          expect(ring.width, `${theme} ${surface} ${control} ring width`).toBeGreaterThanOrEqual(2)
          expect(ratio, `${theme} ${surface} ${control} ring contrast`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  } finally {
    await harness.close()
  }
})
