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

type Probe = { label: string; width: number; style: string; color: Rgb; points: { x: number; y: number }[] }

const probeRing = (page: Page, label: string): Promise<Probe> =>
  page.evaluate((label) => {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement) || !focused.matches(":focus-visible")) throw new Error(label + ": nothing keyboard-focused")
    const ring = focused.closest("ui-input-group, [data-focus-group]") ?? focused
    const style = getComputedStyle(ring)
    const width = Number.parseFloat(style.outlineWidth)
    const offset = Number.parseFloat(style.outlineOffset)
    const box = ring.getBoundingClientRect()
    const out = offset + width / 2
    const midX = box.left + box.width / 2
    const midY = box.top + box.height / 2
    const [r = 0, g = 0, b = 0] = (style.outlineColor.match(/[\d.]+/g) ?? []).map(Number)
    return {
      label,
      width,
      style: style.outlineStyle,
      color: [r, g, b] as [number, number, number],
      points: [
        { x: midX, y: box.top - out },
        { x: midX, y: box.bottom + out },
        { x: box.left - out, y: midY },
        { x: box.right + out, y: midY },
      ].map((point) => ({ x: Math.round(point.x - 0.5), y: Math.round(point.y - 0.5) })),
    }
  }, label)

const pixels = async (page: Page, points: readonly { x: number; y: number }[]): Promise<Rgb[]> => {
  const png = (await page.screenshot()).toString("base64")
  return page.evaluate(
    async ({ png, points }) => {
      const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob())
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext("2d", { willReadFrequently: true })
      if (context === null) throw new Error("no 2d context")
      context.drawImage(bitmap, 0, 0)
      return points.map((point) => {
        const [r = 0, g = 0, b = 0] = context.getImageData(point.x, point.y, 1, 1).data
        return [r, g, b] as [number, number, number]
      })
    },
    { png, points },
  )
}

const tabTo = async (page: Page, matches: string): Promise<void> => {
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press("Tab")
    if (await page.evaluate((matches) => document.activeElement?.matches(matches) === true, matches)) return
  }
  throw new Error("Tab never reached " + matches)
}

const CASES = [
  { label: "clipped tab", target: '[data-case="tab"] [role="tab"]:last-of-type' },
  { label: "search field", target: '[data-case="search"] input' },
  { label: "overview header", target: '[data-case="section"] button[aria-expanded]' },
] as const

test("the ring stays whole where scroll strips, stacked cards and search groups would hide it", async () => {
  const harness = await startHarness()
  try {
    for (const theme of THEMES) {
      const page = await harness.open("focus-ring", { search: "?cases=1&theme=" + theme })
      const focusCases = CASES.map(({ label, target }) => ({
        label,
        focus: async () => {
          await page.mouse.click(1, 1)
          await tabTo(page, target)
        },
      }))
      const stacked = {
        label: "stacked card above the checked card",
        focus: async () => {
          await page.click('[data-case="card"] [role="radio"]:nth-child(2)')
          await page.keyboard.press("Shift+Tab")
        },
      }
      for (const { label, focus } of [...focusCases, stacked]) {
        await focus()
        await page.waitForTimeout(250)
        const probe = await probeRing(page, label)
        expect(probe.style, theme + " " + label + " outline style").toBe("solid")
        expect(probe.width, theme + " " + label + " ring width").toBeGreaterThanOrEqual(2)
        const seen = await pixels(page, probe.points)
        seen.forEach((pixel, side) => {
          const distance = Math.max(...pixel.map((channel, index) => Math.abs(channel - (probe.color[index] ?? 0))))
          expect(distance, theme + " " + label + " ring side " + side + " painted rgb(" + pixel.join(",") + ")").toBeLessThanOrEqual(6)
        })
      }
      await page.close()
    }
  } finally {
    await harness.close()
  }
})

test("under forced colors a highlighted option and a focused control keep a 2px outline", async () => {
  const harness = await startHarness()
  try {
    const page = await harness.open("focus-ring", { search: "?cases=1", before: (page) => page.emulateMedia({ forcedColors: "active" }) })
    await page.mouse.click(1, 1)
    await tabTo(page, '[data-case="search"] input')
    const search = await probeRing(page, "search field")
    expect(search.style).toBe("solid")
    expect(search.width).toBeGreaterThanOrEqual(2)
    await tabTo(page, '[data-case="menu"] button')
    await page.keyboard.press("Enter")
    await page.waitForSelector("ui-menu-item[data-highlighted]")
    const option = await page.evaluate(() => {
      const item = document.querySelector("ui-menu-item[data-highlighted]")
      if (item === null) throw new Error("no highlighted option")
      const style = getComputedStyle(item)
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
    })
    expect(option.style).toBe("solid")
    expect(option.width).toBeGreaterThanOrEqual(2)
    await page.close()
  } finally {
    await harness.close()
  }
})
