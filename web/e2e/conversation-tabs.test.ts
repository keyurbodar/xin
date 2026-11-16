import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import type { Page } from "playwright"
import { holdChunk, startHarness, type Harness } from "./harness.ts"

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
    links.map((link) => ({
      text: link.textContent?.trim(),
      title: link.getAttribute("title"),
      href: link.getAttribute("href"),
      current: link.getAttribute("aria-current"),
    })),
  )

const tab = (page: Page, title: string) => page.locator(`[role=tab][title="${title}"]`)

const tabMenu = (page: Page) => page.getByRole("menu", { name: "Tab actions" })

/** Opens the tab menu on `title` with a right-click and closes it again, so the menu has a target from before. */
async function rightClickAndDismiss(page: Page, title: string): Promise<void> {
  await tab(page, title).click({ button: "right" })
  await tabMenu(page).waitFor({ state: "visible", timeout: 5000 })
  await page.keyboard.press("Escape")
  await tabMenu(page).waitFor({ state: "hidden", timeout: 5000 })
}

test("the header reads project › thread, every crumb is a link, and the last one is the current page", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle" })
  expect(await crumbs(page)).toEqual([{ text: "Ingle", title: "Ingle", href: "#/p/ingle", current: "page" }])
  await tab(page, "Review the breadcrumb header").click()
  await page.waitForFunction(() => document.querySelectorAll("nav[aria-label=Breadcrumb] a").length === 2)
  expect(await crumbs(page)).toEqual([
    { text: "Ingle", title: "Ingle", href: "#/p/ingle", current: null },
    { text: "Review the breadcrumb header", title: "Review the breadcrumb header", href: "#/p/ingle/t/14", current: "page" },
  ])
  await page.locator("nav[aria-label=Breadcrumb] a", { hasText: "Ingle" }).focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => location.hash === "#/p/ingle" && document.querySelectorAll("nav[aria-label=Breadcrumb] a").length === 1)
  expect(await crumbs(page)).toEqual([{ text: "Ingle", title: "Ingle", href: "#/p/ingle", current: "page" }])
  await page.close()
})

test("a right-click on a tab before the menu chunk lands opens its menu once it does, and Close removes that tab", async () => {
  let release = async (): Promise<void> => undefined
  const page = await harness.open("conversation-tabs", {
    search: "#/p/ingle/t/12",
    before: async (page) => {
      release = await holdChunk(page, "menu")
    },
  })
  await tab(page, "Hover cards and link chips").click({ button: "right" })
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => customElements.get("ui-menu") === undefined)).toBe(true)
  await release()
  const menu = tabMenu(page)
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

test("a press on the actions button before the menu chunk lands opens the project menu once it does", async () => {
  let release = async (): Promise<void> => undefined
  const page = await harness.open("conversation-tabs", {
    search: "#/p/ingle",
    before: async (page) => {
      release = await holdChunk(page, "menu")
    },
  })
  await page.getByRole("button", { name: "Ingle actions" }).click()
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => customElements.get("ui-menu") === undefined)).toBe(true)
  await release()
  await page.getByRole("menuitem", { name: "Project settings" }).click({ timeout: 5000 })
  expect(await page.evaluate(() => (window as unknown as { actions: string[] }).actions)).toEqual(["settings"])
  await page.close()
})

test("conversation-tabs.tsx imports no Ark", async () => {
  const source = await Bun.file(new URL("../src/components/shell/conversation-tabs.tsx", import.meta.url)).text()
  expect(source.includes("@ark-ui")).toBe(false)
})

test("at 390 the header fits the window and the current crumb keeps its width clear of the actions button, before and after the menu elements load", async () => {
  const page = await harness.open("conversation-tabs", { width: 390, search: "?project=Ingle%20personal%20agent%20backend#/p/ingle/t/14" })
  const look = () =>
    page.evaluate(() => {
      const crumb = document.querySelector("nav[aria-label=Breadcrumb] a[aria-current=page]")?.getBoundingClientRect()
      const actions = document.querySelector("button[aria-label$=' actions']")?.getBoundingClientRect()
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        width: Math.round(crumb?.width ?? 0),
        gap: Math.round((actions?.left ?? 0) - (crumb?.right ?? Infinity)),
      }
    })
  for (const loaded of [false, true]) {
    if (loaded) {
      await tab(page, "Sidebar v2 on UI SDK").hover()
      await page.waitForFunction(() => customElements.get("ui-menu") !== undefined)
      await page.waitForTimeout(200)
    }
    const { overflow, width, gap } = await look()
    expect(overflow).toBe(0)
    expect(width).toBeGreaterThanOrEqual(60)
    expect(gap).toBeGreaterThanOrEqual(0)
  }
  await page.close()
})

test("a touch hold on a tab opens the menu for that tab, not the one right-clicked before", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle/t/12" })
  await rightClickAndDismiss(page, "Sidebar v2 on UI SDK")
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = await tab(page, "Hover cards and link chips").boundingBox()
  if (box === null) throw new Error("the tab has no box")
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await page.waitForTimeout(800)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await tabMenu(page).waitFor({ state: "visible", timeout: 5000 })
  await page.getByRole("menuitem", { name: "Close", exact: true }).click()
  await tab(page, "Hover cards and link chips").waitFor({ state: "detached", timeout: 5000 })
  expect(await tab(page, "Sidebar v2 on UI SDK").count()).toBe(1)
  await page.close()
})

test("the ContextMenu key opens the menu for the focused tab, not the one right-clicked before", async () => {
  const page = await harness.open("conversation-tabs", { search: "#/p/ingle/t/12" })
  await rightClickAndDismiss(page, "Sidebar v2 on UI SDK")
  await tab(page, "Hover cards and link chips").focus()
  await page.keyboard.press("ContextMenu")
  await tabMenu(page).waitFor({ state: "visible", timeout: 5000 })
  await page.getByRole("menuitem", { name: "Close", exact: true }).click()
  await tab(page, "Hover cards and link chips").waitFor({ state: "detached", timeout: 5000 })
  expect(await tab(page, "Sidebar v2 on UI SDK").count()).toBe(1)
  await page.close()
})
