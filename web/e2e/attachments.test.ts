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

const settled = (page: Page) => page.waitForTimeout(300)
const focusedCard = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("ui-file-input-item")?.querySelector(".truncate")?.textContent ?? "")
const cards = (page: Page) =>
  page.locator("ui-file-input-item").evaluateAll((items) => items.map((item) => item.querySelector(".truncate")?.textContent ?? ""))
const meta = (page: Page, name: string) =>
  page.locator("ui-file-input-item", { hasText: name }).locator(".truncate").nth(1).textContent()

test("cards show size and kind, upload progress as a ring, and why an upload failed", async () => {
  const page = await harness.open("attachments")
  await settled(page)
  expect(await cards(page)).toEqual(["screenshot.png", "diagram.png", "brief.md", "deck.pdf", "capture.mov"])
  expect(await meta(page, "screenshot.png")).toBe("215 KB · PNG")
  expect(await meta(page, "diagram.png")).toBe("1.3 MB · 42%")
  expect(await page.getByRole("progressbar", { name: "Uploading diagram.png" }).getAttribute("aria-valuenow")).toBe("42")
  expect(await meta(page, "deck.pdf")).toBe("4 KB · HTTP 500")
  expect(await meta(page, "capture.mov")).toBe("51.0 MB · Too big · 50 MB max")
  expect(await page.locator("ui-file-input-item[data-state=failed]").count()).toBe(2)
  expect(await page.textContent("#ready")).toBe("screenshot.png,brief.md")
  await page.close()
})

test("progress moves the ring and a finished upload shows its kind and becomes sendable", async () => {
  const page = await harness.open("attachments")
  await settled(page)
  await page.evaluate(() => Reflect.get(window, "progress")("diagram.png", 0.9))
  expect(await meta(page, "diagram.png")).toBe("1.3 MB · 90%")
  await page.evaluate(() => Reflect.get(window, "finish")("diagram.png"))
  await settled(page)
  expect(await meta(page, "diagram.png")).toBe("1.3 MB · PNG")
  expect(await page.getByRole("progressbar").count()).toBe(0)
  expect(await page.textContent("#ready")).toBe("screenshot.png,diagram.png,brief.md")
  await page.close()
})

test("a card's remove button removes only that file", async () => {
  const page = await harness.open("attachments")
  await settled(page)
  await page.getByRole("button", { name: "Remove brief.md" }).click()
  await settled(page)
  expect(await page.textContent("#removed")).toBe("brief.md")
  expect(await cards(page)).toEqual(["screenshot.png", "diagram.png", "deck.pdf", "capture.mov"])
  expect(await page.locator("ui-file-input-item").count()).toBe(4)
  await page.close()
})

test("the grid is one Tab stop, arrows move between cards and Delete or Backspace removes the focused one", async () => {
  const page = await harness.open("attachments")
  await settled(page)
  await page.focus("#before")
  await page.keyboard.press("Tab")
  expect(await focusedCard(page)).toBe("screenshot.png")
  await page.keyboard.press("ArrowRight")
  expect(await focusedCard(page)).toBe("diagram.png")
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe("solid")
  await page.keyboard.press("End")
  expect(await focusedCard(page)).toBe("capture.mov")
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Delete")
  await settled(page)
  expect(await page.textContent("#removed")).toBe("diagram.png")
  expect(await focusedCard(page)).toBe("brief.md")
  await page.keyboard.press("Backspace")
  await settled(page)
  expect(await page.textContent("#removed")).toBe("diagram.png,brief.md")
  expect(await focusedCard(page)).toBe("deck.pdf")
  expect(await cards(page)).toEqual(["screenshot.png", "deck.pdf", "capture.mov"])
  await page.keyboard.press("Tab")
  expect(await focusedCard(page)).toBe("")
  await page.close()
})

test("removing the last card leaves no list behind and new files fill it again", async () => {
  const page = await harness.open("attachments")
  await settled(page)
  await page.focus("#before")
  await page.keyboard.press("Tab")
  for (let index = 0; index < 5; index++) await page.keyboard.press("Delete")
  await settled(page)
  expect(await page.locator("ui-file-input-item").count()).toBe(0)
  expect(await page.locator("ui-file-input").isHidden()).toBe(true)
  await page.evaluate(() => Reflect.get(window, "addAgain")())
  await settled(page)
  expect(await cards(page)).toEqual(["screenshot.png", "diagram.png"])
  await page.close()
})

test("a sent image opens by click or keyboard with its index, and other files are not buttons", async () => {
  const page = await harness.open("attachments")
  await settled(page)
  await page.getByRole("button", { name: "Open diagram.png" }).click()
  expect(await page.textContent("#opened")).toBe("1")
  await page.getByRole("button", { name: "Open screenshot.png" }).focus()
  await page.keyboard.press("Enter")
  expect(await page.textContent("#opened")).toBe("0")
  expect(await page.getByRole("button", { name: "Open brief.md" }).count()).toBe(0)
  const thumbnail = page.getByRole("button", { name: "Open screenshot.png" }).locator("img")
  expect(await thumbnail.getAttribute("src")).toStartWith("blob:")
  await page.close()
})
