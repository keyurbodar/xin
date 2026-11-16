import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import type { Page } from "playwright"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(60_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

const settled = (page: Page) => page.waitForTimeout(400)
const dialogName = (page: Page) => page.locator("ui-dialog-title").textContent()
const requested = (page: Page): Promise<readonly string[]> => page.evaluate(() => Reflect.get(window, "requested"))
const live = (page: Page): Promise<number> => page.evaluate(() => Reflect.get(window, "live")())
const sha = (letter: string) => letter.repeat(64)
const LONG_PREFIX = "e"

test("only small raster images read a thumbnail, and only ones whose bytes decode become Open buttons", async () => {
  const page = await harness.open("sent-attachments")
  await settled(page)
  const opens = await page.getByRole("button", { name: /^Open / }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))
  expect(opens).toEqual(["Open screenshot.png", "Open diagram.png"])
  expect([...(await requested(page))].sort()).toEqual([sha("a"), sha("c"), sha("f")])
  const card = (name: string) => page.locator("li", { hasText: name })
  expect(await card("screenshot.png").locator("[data-slot=tile][data-phase=shown] img").count()).toBe(1)
  expect(await card("page.png").locator("img").count()).toBe(0)
  expect(await card("logo.svg").locator("img").count()).toBe(0)
  expect(await card("diagram.png").locator("[data-slot=tile]").count()).toBe(0)
  expect(await page.evaluate(() => Reflect.get(window, "pwned"))).toBeUndefined()
  await page.close()
})

test("a large image loads in full only when the lightbox opens it, beside the message's decoded images", async () => {
  const page = await harness.open("sent-attachments")
  await settled(page)
  expect(await requested(page)).not.toContain(sha("b"))
  const opener = page.getByRole("button", { name: "Open diagram.png" })
  await opener.click()
  await settled(page)
  expect((await requested(page)).filter((entry) => entry === sha("b"))).toHaveLength(1)
  expect(await dialogName(page)).toContain("diagram.png")
  expect(await page.getByRole("option").count()).toBe(2)
  await page.keyboard.press("ArrowLeft")
  await settled(page)
  expect(await dialogName(page)).toContain("screenshot.png")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("dialog").count()).toBe(0)
  expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.getByRole("button", { name: "Open screenshot.png" }).focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await dialogName(page)).toContain("screenshot.png")
  expect((await requested(page)).filter((entry) => entry === sha("a"))).toHaveLength(1)
  await page.close()
})

test("a long thread reads thumbnails only as they scroll into view, each once", async () => {
  const page = await harness.open("sent-attachments", { search: "?long=1" })
  await settled(page)
  const long = async () => (await requested(page)).filter((entry) => entry.startsWith(LONG_PREFIX))
  const atTop = (await long()).length
  expect(atTop).toBeGreaterThan(0)
  expect(atTop).toBeLessThan(12)
  for (let step = 0; step < 12; step++) {
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(120)
  }
  await page.mouse.wheel(0, -100_000)
  await page.waitForTimeout(120)
  await page.mouse.wheel(0, 100_000)
  await settled(page)
  const all = await long()
  expect(new Set(all).size).toBe(34)
  expect(all).toHaveLength(34)
  expect(await requested(page)).not.toContain(sha("b"))
  await page.close()
})

test("switching thread revokes every object URL the transcript made", async () => {
  const page = await harness.open("sent-attachments", { search: "?long=1" })
  await settled(page)
  expect(await live(page)).toBeGreaterThan(0)
  await page.click("#switch")
  await settled(page)
  expect(await live(page)).toBe(0)
  await page.close()
})
