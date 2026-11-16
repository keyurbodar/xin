import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import type { Page } from "playwright"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(120_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

const settled = (page: Page) => page.waitForTimeout(300)
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls)
const navLinks = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("nav[aria-label=Settings] a")].filter((link) => link.checkVisibility()).map((link) => link.textContent?.trim()),
  )
const visibleSections = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("section.settings-section")].filter((section) => section.checkVisibility()).map((section) => section.getAttribute("aria-label")),
  )
const visibleRows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-settings-row]")].filter((row) => row.checkVisibility()).map((row) => row.getAttribute("data-settings-row")),
  )

async function open(path: string, width = 1280): Promise<Page> {
  const page = await harness.open("settings", { search: `#${path}`, width })
  await page.waitForSelector("section.settings-section")
  await settled(page)
  return page
}

test("the nav is grouped into Account, Agent and Workspace", async () => {
  const page = await open("/settings/general")
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll("nav[aria-label=Settings] [role=group]")].map((group) => group.getAttribute("aria-label")),
  )
  expect(groups).toEqual(["Account", "Agent", "Workspace"])
  expect(await navLinks(page)).toEqual(["General", "Profile + token", "Notifications", "Models + providers", "Plugins", "Usage + cost", "Members", "System"])
  expect(await page.locator("nav[aria-label=Settings] a[aria-current=page]").textContent()).toBe("General")
  await page.close()
})

test("search filters the nav by a setting's label and the page's rows by label and helper text", async () => {
  const page = await open("/settings/notifications")
  await page.getByLabel("Search settings").fill("quiet")
  await settled(page)
  expect(await navLinks(page)).toEqual(["Notifications"])
  expect(await visibleSections(page)).toEqual(["Quiet hours"])
  expect(await visibleRows(page)).toEqual(["Quiet hours"])
  await page.getByLabel("Search settings").fill("buttons")
  await settled(page)
  expect(await visibleRows(page)).toEqual(["A thread is waiting on you"])
  expect(await visibleSections(page)).toEqual(["Tell me when"])
  await page.getByLabel("Search settings").press("Escape")
  await settled(page)
  expect(await page.getByLabel("Search settings").inputValue()).toBe("")
  expect((await visibleRows(page)).length).toBeGreaterThan(5)
  await page.close()
})

test("a search with no match says so in the nav and on the page", async () => {
  const page = await open("/settings/general")
  await page.getByLabel("Search settings").fill("zebra")
  await settled(page)
  expect(await navLinks(page)).toEqual([])
  expect(await page.getByText("No settings match “zebra”.").isVisible()).toBe(true)
  expect(await page.getByText("Nothing on General matches “zebra”.").isVisible()).toBe(true)
  await page.getByRole("button", { name: "Show all" }).click()
  await settled(page)
  expect((await navLinks(page)).length).toBe(8)
  await page.close()
})

test("every section and row label on every page finds that page from the search", async () => {
  const page = await open("/settings/general")
  const entries = await page.evaluate(() =>
    [...document.querySelectorAll("nav[aria-label=Settings] a")].map((link) => ({ href: link.getAttribute("href") ?? "", label: link.textContent?.trim() ?? "" })),
  )
  const misses: string[] = []
  for (const entry of entries) {
    await page.evaluate((href) => {
      window.location.hash = href
    }, entry.href)
    await page.waitForTimeout(700)
    const labels = [...(await visibleSections(page)), ...(await visibleRows(page))].filter((label): label is string => label !== null)
    for (const label of labels) {
      await page.getByLabel("Search settings").fill(label)
      await page.waitForTimeout(50)
      if (!(await navLinks(page)).includes(entry.label)) misses.push(`${entry.label}: ${label}`)
    }
    await page.getByLabel("Search settings").fill("")
  }
  expect(misses).toEqual([])
  await page.close()
})

test("the breadcrumb reads Settings › page and every crumb is a link", async () => {
  const page = await open("/settings/usage")
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")
  expect(await crumbs.allTextContents()).toEqual(["Settings", "Usage + cost"])
  expect(await crumbs.nth(0).getAttribute("href")).toBe("#/settings")
  expect(await crumbs.nth(1).getAttribute("href")).toBe("#/settings/usage")
  expect(await crumbs.nth(1).getAttribute("aria-current")).toBe("page")
  await crumbs.nth(0).click()
  await settled(page)
  expect(await page.evaluate(() => window.location.hash)).toBe("#/settings")
  await page.close()
})

test("a notification switch is a UI SDK switch: Space sends one notify.set and the switch follows it", async () => {
  const page = await open("/settings/notifications")
  const schedule = page.getByRole("switch", { name: "A schedule runs" })
  expect(await schedule.getAttribute("aria-checked")).toBe("false")
  await schedule.focus()
  await page.keyboard.press("Space")
  await page.waitForTimeout(600)
  expect((await calls(page)).filter((op) => op === "notify.set")).toEqual(["notify.set"])
  expect(await page.evaluate(() => (window as unknown as { state: { prefs: { schedule: boolean } } }).state.prefs.schedule)).toBe(true)
  expect(await schedule.getAttribute("aria-checked")).toBe("true")
  await page.close()
})

test("a plugin row switch sends one plugin.enable", async () => {
  const page = await open("/settings/plugins")
  await page.getByRole("switch", { name: "Turn on Outline" }).click()
  await page.waitForTimeout(600)
  expect((await calls(page)).filter((op) => op === "plugin.enable")).toEqual(["plugin.enable"])
  expect(await page.getByRole("switch", { name: "Turn off Outline" }).getAttribute("aria-checked")).toBe("true")
  await page.close()
})

test("a model default is a UI SDK select: the keyboard picks a model and sends one owner.defaults", async () => {
  const page = await open("/settings/general")
  const trigger = page.getByRole("combobox", { name: "Coordinator" })
  await trigger.focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.getByRole("option", { name: "Sonnet" }).isVisible()).toBe(true)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(600)
  expect((await calls(page)).filter((op) => op === "owner.defaults")).toEqual(["owner.defaults"])
  expect(await trigger.textContent()).toContain("Sonnet")
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Coordinator")
  await page.close()
})

test("the name field saves through owner.set as before", async () => {
  const page = await open("/settings/general")
  const name = page.getByLabel("Your name")
  expect(await name.inputValue()).toBe("Ada")
  await name.fill("Ada L")
  await page.waitForTimeout(1200)
  expect((await calls(page)).filter((op) => op === "owner.set")).toEqual(["owner.set"])
  await page.close()
})

test("on a phone Settings opens as a grouped list and a page opens with its breadcrumb", async () => {
  const page = await harness.open("settings", { search: "#/settings", width: 390 })
  await settled(page)
  expect(await page.getByRole("heading", { name: "Settings" }).isVisible()).toBe(true)
  expect(await page.locator("section.settings-section").first().isVisible()).toBe(false)
  await page.getByRole("link", { name: "Notifications" }).click()
  await page.waitForSelector("section.settings-section")
  await settled(page)
  expect(await page.getByLabel("Search settings").isVisible()).toBe(false)
  const settings = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Settings" })
  await settings.click()
  await settled(page)
  expect(await page.getByLabel("Search settings").isVisible()).toBe(true)
  await page.close()
})

for (const [label, reduce] of [
  ["the OS setting", (page: Page) => page.emulateMedia({ reducedMotion: "reduce" })],
  ["Reduce motion", (page: Page) => page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduce"))],
] as const) {
  test(`under reduced motion from ${label} the switch thumb does not slide`, async () => {
    const page = await harness.open("settings", { search: "#/settings/notifications", width: 1280 })
    await page.waitForSelector("[data-slot=switch-thumb]")
    expect(await page.locator("[data-slot=switch-thumb]").first().evaluate((thumb) => getComputedStyle(thumb).transitionProperty)).toContain("translate")
    await reduce(page)
    const property = await page.locator("[data-slot=switch-thumb]").first().evaluate((thumb) => getComputedStyle(thumb).transitionProperty)
    expect(property).toBe("background-color")
    await page.close()
  })
}
