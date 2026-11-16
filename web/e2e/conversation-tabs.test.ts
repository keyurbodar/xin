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

const crumbs = (page: Page) =>
  page.locator("nav[aria-label=Breadcrumb] a").evaluateAll((links) =>
    links.map((link) => ({ text: link.textContent?.trim(), href: link.getAttribute("href"), current: link.getAttribute("aria-current") })),
  )

const tab = (page: Page, title: string) => page.locator(`[role=tab][title="${title}"]`)

test("the header reads project › thread, every crumb is a link, and the last one is the current page", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle" })
  expect(await crumbs(page)).toEqual([{ text: "Ingle", href: "#/p/ingle", current: "page" }])
  await tab(page, "Review the breadcrumb header").click()
  await page.waitForFunction(() => document.querySelectorAll("nav[aria-label=Breadcrumb] a").length === 2)
  expect(await crumbs(page)).toEqual([
    { text: "Ingle", href: "#/p/ingle", current: null },
    { text: "Review the breadcrumb header", href: "#/p/ingle/t/14", current: "page" },
  ])
  await page.locator("nav[aria-label=Breadcrumb] a", { hasText: "Ingle" }).focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => location.hash === "#/p/ingle" && document.querySelectorAll("nav[aria-label=Breadcrumb] a").length === 1)
  expect(await crumbs(page)).toEqual([{ text: "Ingle", href: "#/p/ingle", current: "page" }])
  await page.close()
})

test("a cold right-click on a tab opens its UI SDK menu, and Close removes that tab", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle/t/12" })
  expect(await page.evaluate(() => customElements.get("ui-menu") === undefined)).toBe(true)
  await tab(page, "Hover cards and link chips").click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Tab actions" })
  await menu.waitFor({ state: "visible", timeout: 5000 })
  expect(await page.getByRole("menuitem", { name: "Close to the right" }).getAttribute("aria-disabled")).toBe("true")
  expect(await page.getByRole("menuitem", { name: "Close others" }).getAttribute("aria-disabled")).not.toBe("true")
  await page.getByRole("menuitem", { name: "Close", exact: true }).click()
  await page.waitForTimeout(400)
  expect(await tab(page, "Hover cards and link chips").count()).toBe(0)
  expect(await tab(page, "Sidebar v2 on UI SDK").count()).toBe(1)
  await page.close()
})

test("Shift+F10 opens the tab menu on the keyboard, and Escape returns focus to the tab", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle/t/12" })
  const first = tab(page, "Sidebar v2 on UI SDK")
  await first.focus()
  await page.waitForTimeout(300)
  await page.keyboard.press("Shift+F10")
  await page.getByRole("menu", { name: "Tab actions" }).waitFor({ state: "visible", timeout: 5000 })
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Open in new window")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  expect(await page.getByRole("menu", { name: "Tab actions" }).isVisible()).toBe(false)
  expect(await first.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.close()
})

test("a cold press on the actions button opens the project menu and runs its action", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle" })
  await page.getByRole("button", { name: "Ingle actions" }).click()
  await page.getByRole("menuitem", { name: "Project settings" }).click({ timeout: 5000 })
  expect(await page.evaluate(() => (window as unknown as { actions: string[] }).actions)).toEqual(["settings"])
  await page.close()
})

test("conversation-tabs.tsx imports no Ark", async () => {
  const source = await Bun.file(new URL("../src/components/shell/conversation-tabs.tsx", import.meta.url)).text()
  expect(source.includes("@ark-ui")).toBe(false)
})

test("at 390 the header fits the window, before and after the menu elements load", async () => {
  const page = await harness.open("conversation-tabs", { width: 390, search: "#/p/ingle/t/14" })
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await overflow()).toBe(0)
  await tab(page, "Sidebar v2 on UI SDK").hover()
  await page.waitForFunction(() => customElements.get("ui-menu") !== undefined)
  await page.waitForTimeout(200)
  expect(await overflow()).toBe(0)
  await page.close()
})
