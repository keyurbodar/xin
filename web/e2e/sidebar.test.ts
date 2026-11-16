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

const segment = (page: Page, name: string) => page.getByRole("radio", { name })
const rows = (page: Page) => page.locator("aside button").allTextContents()

const menuShown = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector("ui-menu-content")
    return content !== null && !content.hasAttribute("hidden") && content.getBoundingClientRect().height > 0
  })

test("Threads shows the current project's threads, Captains swaps in the Captains, and the pick survives a reload", async () => {
  const page = await harness.open("sidebar")
  expect(await segment(page, "Threads").getAttribute("aria-checked")).toBe("true")
  expect((await rows(page)).join("|")).toContain("Sidebar v2 on UI SDK")
  expect((await rows(page)).join("|")).not.toContain("Atlas")
  await segment(page, "Captains").click()
  expect(await segment(page, "Captains").getAttribute("aria-checked")).toBe("true")
  expect((await rows(page)).join("|")).toContain("Atlas")
  expect((await rows(page)).join("|")).not.toContain("Sidebar v2 on UI SDK")
  expect(await page.getByRole("button", { name: "New Captain" }).isVisible()).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem("ingle.sidebar.section"))).toBe("captains")
  await page.reload()
  await page.waitForFunction(() => document.body.dataset.ready === "1")
  expect(await segment(page, "Captains").getAttribute("aria-checked")).toBe("true")
  expect((await rows(page)).join("|")).toContain("Bosun")
  await page.close()
})

test("the toggle is one tab stop and arrow keys switch it without animating the indicator", async () => {
  const page = await harness.open("sidebar")
  await segment(page, "Threads").focus()
  await page.keyboard.press("ArrowRight")
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Captains")
  expect(await segment(page, "Captains").getAttribute("aria-checked")).toBe("true")
  expect((await rows(page)).join("|")).toContain("Atlas")
  const indicator = page.locator("[data-slot=segmented-control-indicator]")
  expect(await indicator.getAttribute("data-instant")).toBe("")
  expect(await indicator.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")
  await page.keyboard.press("ArrowLeft")
  expect(await segment(page, "Threads").getAttribute("aria-checked")).toBe("true")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Search threads")
  await page.close()
})

test("a pointer switch slides the indicator, and both reduce-motion paths keep it still", async () => {
  const page = await harness.open("sidebar")
  const indicator = page.locator("[data-slot=segmented-control-indicator]")
  await segment(page, "Captains").click()
  expect(await indicator.evaluate((element) => getComputedStyle(element).transitionDuration)).not.toBe("0s")
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await indicator.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduce"))
  expect(await indicator.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")
  await page.close()
})

test("the current thread is marked as the page and the thread filter clears on Escape", async () => {
  const page = await harness.open("sidebar")
  const current = page.locator("aside button[aria-current=page]")
  expect(await current.textContent()).toContain("Sidebar v2 on UI SDK")
  expect(await current.getAttribute("class")).toContain("bg-secondary")
  await page.getByRole("button", { name: "Search threads" }).click()
  await page.waitForTimeout(50)
  await page.keyboard.type("review")
  expect((await rows(page)).join("|")).not.toContain("Sidebar v2 on UI SDK")
  expect((await rows(page)).join("|")).toContain("Review the breadcrumb header")
  await page.keyboard.press("Escape")
  expect(await page.getByRole("textbox").count()).toBe(0)
  expect((await rows(page)).join("|")).toContain("Sidebar v2 on UI SDK")
  await page.close()
})

test("the account chip names the owner and this home, and its menu runs on the keyboard", async () => {
  const page = await harness.open("sidebar")
  const chip = page.locator("ui-menu-trigger > button")
  await page.waitForFunction(() => document.querySelector("ui-menu-trigger > button")?.textContent?.includes("Ada Lovelace"))
  const host = await page.evaluate(() => location.host)
  expect(await chip.textContent()).toContain(host)
  await chip.focus()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(200)
  const menu = page.getByRole("menu")
  expect(await menu.isVisible()).toBe(true)
  expect(await page.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true")
  await page.getByRole("menuitemradio", { name: "Light" }).click()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light")
  expect(await menu.isVisible()).toBe(true)
  expect(await page.getByRole("menuitemradio", { name: "Light" }).getAttribute("aria-checked")).toBe("true")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(200)
  expect(await menu.isVisible()).toBe(false)
  expect(await chip.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press("Enter")
  await page.waitForTimeout(200)
  await page.keyboard.press("Enter")
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => location.hash)).toBe("#/settings/general")
  await page.close()
})

test("the owner menu loads on first use, and a cold keyboard open shows it with the first item focused", async () => {
  const page = await harness.open("sidebar")
  const chip = page.locator("ui-menu-trigger > button")
  await page.waitForFunction(() => document.querySelector("ui-menu-trigger > button")?.textContent?.includes("Ada Lovelace"))
  const before = await page.evaluate(() => ({
    defined: customElements.get("ui-menu-content") !== undefined,
    hidden: document.querySelector("ui-menu-content")?.hasAttribute("hidden"),
    visible: (document.querySelector("ui-menu-content")?.getBoundingClientRect().height ?? 0) > 0,
  }))
  expect(before).toEqual({ defined: false, hidden: true, visible: false })
  await chip.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menu").waitFor({ state: "visible", timeout: 5000 })
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Settings")
  await page.close()
})

test("a double press before the menu chunk lands opens the menu once and leaves it open", async () => {
  let release = async (): Promise<void> => undefined
  const page = await harness.open("sidebar", {
    before: async (page) => {
      release = await holdChunk(page, "menu")
    },
  })
  const chip = page.locator("ui-menu-trigger > button")
  await page.waitForFunction(() => document.querySelector("ui-menu-trigger > button")?.textContent?.includes("Ada Lovelace"))
  await chip.click()
  await chip.click()
  await page.waitForTimeout(200)
  expect(await menuShown(page)).toBe(false)
  await release()
  await page.getByRole("menu").waitFor({ state: "visible", timeout: 5000 })
  await page.waitForTimeout(400)
  expect(await menuShown(page)).toBe(true)
  await page.close()
})

test("an aborted menu chunk raises no page error, and the next press loads it and opens the menu", async () => {
  const errors: string[] = []
  let release = async (): Promise<void> => undefined
  const page = await harness.open("sidebar", {
    before: async (page) => {
      page.on("pageerror", (error) => errors.push(String(error)))
      release = await holdChunk(page, "menu", true)
    },
  })
  const chip = page.locator("ui-menu-trigger > button")
  await page.waitForFunction(() => document.querySelector("ui-menu-trigger > button")?.textContent?.includes("Ada Lovelace"))
  await chip.hover()
  await chip.click()
  await page.waitForTimeout(400)
  expect(await menuShown(page)).toBe(false)
  expect(errors).toEqual([])
  await release()
  await chip.click()
  await page.getByRole("menu").waitFor({ state: "visible", timeout: 5000 })
  expect(errors).toEqual([])
  await page.close()
})

test("before Segmented Control loads, the stored section already shows checked under an indicator that does not move", async () => {
  for (const section of ["threads", "captains"]) {
    let release = async (): Promise<void> => undefined
    const page = await harness.open("sidebar", {
      before: async (page) => {
        await page.addInitScript((value) => localStorage.setItem("ingle.sidebar.section", value), section)
        release = await holdChunk(page, "segmented-control")
      },
    })
    const look = () =>
      page.evaluate(() => {
        const indicator = document.querySelector("ui-segmented-control-indicator")?.getBoundingClientRect()
        const checked = [...document.querySelectorAll("ui-segmented-control-item")].filter((item) => item.hasAttribute("data-checked"))
        return {
          indicator: indicator === undefined ? undefined : [indicator.x, indicator.y, indicator.width, indicator.height].map(Math.round),
          checked: checked.map((item) => item.getAttribute("value")),
        }
      })
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => customElements.get("ui-segmented-control") === undefined)).toBe(true)
    const before = await look()
    expect(before.checked).toEqual([section])
    await release()
    await page.waitForFunction(() => customElements.get("ui-segmented-control") !== undefined)
    await page.waitForTimeout(300)
    expect(await look()).toEqual(before)
    expect(await segment(page, section === "threads" ? "Threads" : "Captains").getAttribute("aria-checked")).toBe("true")
    await page.close()
  }
})

const item = (page: Page, value: string) => page.locator(`ui-segmented-control-item[value=${value}]`)

test("an aborted Segmented Control chunk raises no page error, and the next press loads it and switches the section", async () => {
  const errors: string[] = []
  let release = async (): Promise<void> => undefined
  const page = await harness.open("sidebar", {
    expected: /Failed to load resource/,
    before: async (page) => {
      page.on("pageerror", (error) => errors.push(String(error)))
      release = await holdChunk(page, "segmented-control", true)
    },
  })
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => customElements.get("ui-segmented-control") === undefined)).toBe(true)
  await release()
  await item(page, "captains").click()
  await page.waitForFunction(() => document.querySelector("ui-segmented-control-item[value=captains]")?.getAttribute("aria-checked") === "true", undefined, {
    timeout: 5000,
  })
  expect((await rows(page)).join("|")).toContain("Atlas")
  expect(errors).toEqual([])
  await page.close()
})

test("a press while the Segmented Control chunk is slow switches the section once it lands", async () => {
  let release = async (): Promise<void> => undefined
  const page = await harness.open("sidebar", {
    before: async (page) => {
      release = await holdChunk(page, "segmented-control")
    },
  })
  await item(page, "captains").click()
  await item(page, "captains").click()
  await page.waitForTimeout(200)
  expect((await rows(page)).join("|")).not.toContain("Atlas")
  await release()
  await page.waitForFunction(() => document.querySelector("ui-segmented-control-item[value=captains]")?.getAttribute("aria-checked") === "true", undefined, {
    timeout: 5000,
  })
  await page.waitForTimeout(200)
  expect(await segment(page, "Captains").getAttribute("aria-checked")).toBe("true")
  expect((await rows(page)).join("|")).toContain("Atlas")
  expect(await page.evaluate(() => localStorage.getItem("ingle.sidebar.section"))).toBe("captains")
  await page.close()
})

test("the sidebar sends only owner.read on mount, and switching sections sends nothing", async () => {
  const page = await harness.open("sidebar")
  await page.waitForTimeout(300)
  await segment(page, "Captains").click()
  await segment(page, "Threads").click()
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => (window as unknown as { ops: string[] }).ops)).toEqual(["owner.read"])
  await page.close()
})
