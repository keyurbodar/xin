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
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName)
const isOpen = (page: Page) => page.evaluate(() => document.querySelector("#name") !== null)

test("the dialog is a named modal that focuses its first field and traps Tab", async () => {
  const page = await harness.open("dialog")
  await page.click("#opener")
  await settled(page)
  const dialog = page.getByRole("dialog", { name: "New project" })
  expect(await dialog.getAttribute("aria-modal")).toBe("true")
  expect(await activeId(page)).toBe("name")
  for (let step = 0; step < 6; step++) await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("[data-slot=dialog-content]")?.contains(document.activeElement))).toBe(true)
  await page.close()
})

test("Escape closes it and focus returns to the opener", async () => {
  const page = await harness.open("dialog")
  await page.click("#opener")
  await settled(page)
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await isOpen(page)).toBe(false)
  expect(await activeId(page)).toBe("opener")
  await page.close()
})

test("a press on the scrim closes it, a press inside does not", async () => {
  const page = await harness.open("dialog")
  await page.click("#opener")
  await settled(page)
  await page.click("#notes")
  await settled(page)
  expect(await isOpen(page)).toBe(true)
  await page.mouse.click(10, 10)
  await settled(page)
  expect(await isOpen(page)).toBe(false)
  await page.close()
})

test("a busy dialog refuses Escape and the scrim", async () => {
  const page = await harness.open("dialog")
  await page.click("#opener")
  await settled(page)
  await page.evaluate(() => (window as unknown as { setBusy: (busy: boolean) => void }).setBusy(true))
  await page.keyboard.press("Escape")
  await page.mouse.click(10, 10)
  await settled(page)
  expect(await isOpen(page)).toBe(true)
  await page.close()
})

test("mod+Enter and Enter in a field submit", async () => {
  const page = await harness.open("dialog")
  await page.click("#opener")
  await settled(page)
  await page.keyboard.press("ControlOrMeta+Enter")
  await page.keyboard.press("Enter")
  expect(await page.textContent("#submits")).toBe("2")
  await page.close()
})

test("under reduced motion it still unmounts after closing", async () => {
  const page = await harness.open("dialog")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.click("#opener")
  await settled(page)
  await page.mouse.click(10, 10)
  await settled(page)
  expect(await isOpen(page)).toBe(false)
  await page.close()
})

test("closing from the app unmounts it and focus goes to returnFocus", async () => {
  const page = await harness.open("dialog")
  await page.click("#opener")
  await settled(page)
  await page.evaluate(() => (window as unknown as { closeTo: (id: string) => void }).closeTo("after"))
  await settled(page)
  expect(await isOpen(page)).toBe(false)
  expect(await activeId(page)).toBe("after")
  await page.close()
})
