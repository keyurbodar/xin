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
const active = (page: Page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim())

test("the notifications dialog is a named modal that focuses Turn on and closes on Escape", async () => {
  const page = await harness.open("notifications")
  await page.click("#opener")
  await settled(page)
  const dialog = page.getByRole("dialog", { name: "Get a nudge when a thread needs you" })
  expect(await dialog.getAttribute("aria-modal")).toBe("true")
  expect(await active(page)).toBe("Turn on")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("[data-slot=dialog-content]")?.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("dialog").count()).toBe(0)
  expect(await active(page)).toBe("opener")
  await page.close()
})

test("a press outside the notifications dialog closes it", async () => {
  const page = await harness.open("notifications")
  await page.click("#opener")
  await settled(page)
  await page.mouse.click(8, 790)
  await settled(page)
  expect(await page.getByRole("dialog").count()).toBe(0)
  await page.close()
})

test("the pane view picker filters as you type and Enter opens the highlighted thread", async () => {
  const page = await harness.open("pane-picker")
  await page.getByRole("button", { name: "Open a view" }).click()
  await settled(page)
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("combobox")
  await page.keyboard.type("review")
  await settled(page)
  const options = await page.getByRole("option").allTextContents()
  expect(options.map((text) => text.trim())).toEqual(["Review the spec"])
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.textContent("#picked")).toBe("thread:12")
  expect(await page.getByRole("listbox").count()).toBe(0)
  await page.close()
})

test("arrow keys move through the picker's options and Escape returns focus to its trigger", async () => {
  const page = await harness.open("pane-picker")
  const trigger = page.getByRole("button", { name: "Open a view" })
  await trigger.click()
  await settled(page)
  await page.keyboard.press("ArrowDown")
  const highlighted = await page.evaluate(() => document.querySelector("[data-slot=command-item][data-highlighted]")?.textContent?.trim())
  expect(highlighted).toBe("Files")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("listbox").count()).toBe(0)
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.close()
})

test("the picker shows No match when nothing fits", async () => {
  const page = await harness.open("pane-picker")
  await page.getByRole("button", { name: "Open a view" }).click()
  await settled(page)
  await page.keyboard.type("zzz")
  await settled(page)
  expect(await page.getByText("No match").isVisible()).toBe(true)
  await page.close()
})
