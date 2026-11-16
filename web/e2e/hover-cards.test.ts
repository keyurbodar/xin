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

const card = (page: Page, text: string) => page.locator("[data-slot=hover-card-content]", { hasText: text })
const shown = (page: Page, text: string) => card(page, text).isVisible()
const tabTo = async (page: Page, href: string) => {
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab")
    if ((await page.evaluate(() => document.activeElement?.getAttribute("href"))) === href) return
  }
  throw new Error(`Tab never reached ${href}`)
}
const active = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id)

test("a link chip's card opens after the pointer rests, shows a skeleton while loading, and closes on leave", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("a[href='#pr-54']")
  await page.waitForTimeout(250)
  expect(await page.locator("[data-slot=hover-card-content]:visible").count()).toBe(0)
  await page.waitForTimeout(300)
  const preview = page.locator("[data-slot=hover-card-content]:visible")
  expect(await preview.getByRole("status", { name: "Loading" }).isVisible()).toBe(true)
  await page.waitForTimeout(700)
  expect(await preview.textContent()).toContain("keyurbodar/xin#54")
  expect(await preview.textContent()).toContain("+114")
  expect(await preview.textContent()).toContain("Merged")
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(450)
  expect(await shown(page, "keyurbodar/xin#54")).toBe(false)
  await page.close()
})

test("the next card opens at once while the last one was just open", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("a[href='#pr-60']")
  await page.waitForTimeout(550)
  expect(await shown(page, "design system v2")).toBe(true)
  await page.hover("a[href='#xin-25']")
  await page.waitForTimeout(250)
  expect(await shown(page, "Web UI v2")).toBe(true)
  expect(await card(page, "Web UI v2").getAttribute("data-warm")).toBe("")
  await page.close()
})

test("keyboard focus opens a chip's card and Escape closes it", async () => {
  const page = await harness.open("hover-cards")
  await tabTo(page, "#ama-23")
  await page.waitForTimeout(550)
  expect(await shown(page, "Hover cards and link chips")).toBe(true)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  expect(await shown(page, "Hover cards and link chips")).toBe(false)
  expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#ama-23")
  await page.close()
})

test("each chip kind renders its own details", async () => {
  const page = await harness.open("hover-cards")
  const expectations: [string, string[]][] = [
    ["#xin-25", ["XIN-25", "Ingle · Working"]],
    ["#418f19f", ["418f19f", "presets remove only tool extensions"]],
    ["#tokens", ["web/src/styles/tokens.css", "6.3 KB"]],
  ]
  for (const [href, texts] of expectations) {
    await tabTo(page, href)
    await page.waitForTimeout(550)
    const text = (await page.locator("[data-slot=hover-card-content]:visible").textContent()) ?? ""
    for (const expected of texts) expect(text).toContain(expected)
    expect(text).not.toContain("Goal tracking")
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
  }
  await page.close()
})

test("the sidebar row card opens on hover beside the row with its issues", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("#row")
  await page.waitForTimeout(550)
  const preview = card(page, "HOME-2")
  expect(await preview.isVisible()).toBe(true)
  expect(await preview.textContent()).toContain("⌥1")
  expect(await preview.getByRole("link", { name: /AMA-22/ }).isVisible()).toBe(true)
  const row = await page.locator("#row").boundingBox()
  const box = await preview.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(row!.x + row!.width)
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(450)
  expect(await preview.isVisible()).toBe(false)
  await page.close()
})

test("the message toolbar appears when focus enters the message and is one tab stop with arrow-key roving", async () => {
  const page = await harness.open("hover-cards")
  const toolbar = page.getByRole("toolbar", { name: "Message actions" })
  const opacity = () => toolbar.evaluate((element) => getComputedStyle(element.parentElement!).opacity)
  expect(await opacity()).toBe("0")
  await page.focus("#before-toolbar")
  await page.keyboard.press("Tab")
  expect(await active(page)).toBe("Reply")
  expect(await opacity()).toBe("1")
  await page.keyboard.press("ArrowRight")
  expect(await active(page)).toBe("Copy")
  await page.keyboard.press("ArrowRight")
  expect(await active(page)).toBe("More")
  await page.keyboard.press("ArrowRight")
  expect(await active(page)).toBe("Reply")
  await page.keyboard.press("ArrowLeft")
  expect(await active(page)).toBe("More")
  await page.keyboard.press("Enter")
  expect(await page.textContent("#log")).toBe("more")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("#message")!.contains(document.activeElement))).toBe(false)
  expect(await opacity()).toBe("0")
  await page.close()
})

test("the message toolbar shows on hover and Copy confirms", async () => {
  const page = await harness.open("hover-cards")
  const toolbar = page.getByRole("toolbar", { name: "Message actions" })
  await page.hover("#message p")
  expect(await toolbar.evaluate((element) => getComputedStyle(element.parentElement!).opacity)).toBe("1")
  await page.getByRole("button", { name: "Copy" }).click()
  expect(await page.textContent("#log")).toBe("copy")
  expect(await page.getByRole("button", { name: "Copied" }).isVisible()).toBe(true)
  await page.close()
})
