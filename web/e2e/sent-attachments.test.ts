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

test("a sent message shows thumbnails read once each from /blobs, and only images with readable bytes are buttons", async () => {
  const page = await harness.open("sent-attachments")
  await settled(page)
  const opens = await page.getByRole("button", { name: /^Open / }).allTextContents()
  expect(opens.length).toBe(2)
  expect(await page.getByRole("button", { name: "Open old.png" }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Open brief.md" }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Open screenshot.png" }).locator("img").getAttribute("src")).toStartWith("blob:")
  const requested: string[] = await page.evaluate(() => Reflect.get(window, "requested"))
  expect([...requested].sort()).toEqual([..."abc"].map((letter) => letter.repeat(64)))
  await page.close()
})

test("clicking an image opens the lightbox on it, arrows move through the message's images, Escape returns focus", async () => {
  const page = await harness.open("sent-attachments")
  await settled(page)
  const opener = page.getByRole("button", { name: "Open diagram.png" })
  await opener.click()
  await settled(page)
  expect(await page.getByRole("dialog").count()).toBe(1)
  expect(await dialogName(page)).toContain("diagram.png")
  expect(await page.getByTestId("lightbox-counter").textContent()).toContain("2")
  await page.keyboard.press("ArrowLeft")
  await settled(page)
  expect(await dialogName(page)).toContain("screenshot.png")
  expect(await page.getByRole("option").count()).toBe(2)
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("dialog").count()).toBe(0)
  expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.close()
})

test("a keyboard Enter on an image opens the lightbox, and an image whose bytes are gone is a plain card", async () => {
  const page = await harness.open("sent-attachments")
  await settled(page)
  await page.getByRole("button", { name: "Open screenshot.png" }).focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await dialogName(page)).toContain("screenshot.png")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("button", { name: "Open gone.png" }).count()).toBe(0)
  expect(await page.getByText("gone.png").count()).toBe(1)
  await page.close()
})
