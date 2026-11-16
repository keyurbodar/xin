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

const settled = (page: Page) => page.waitForTimeout(450)
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls.slice())
const count = async (page: Page, op: string) => (await calls(page)).filter((call) => call.startsWith(op)).length
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim())

async function list(): Promise<Page> {
  const page = await harness.open("automations")
  await page.getByRole("button", { name: "Weekly pipeline review", exact: true }).waitFor()
  await settled(page)
  return page
}

async function history(runs = 45): Promise<Page> {
  const page = await harness.open("automations", { search: `?view=a1&runs=${runs}` })
  await page.getByRole("heading", { name: "Weekly pipeline review" }).waitFor()
  await settled(page)
  return page
}

const runRows = (page: Page) => page.locator("[data-slot=collapsible]")

test("the automations surface loads no Ark menu and renders every row at the list-row height", async () => {
  const page = await list()
  const heights = await page.locator("[data-automation]").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))
  expect(heights).toEqual([36, 36, 36])
  expect(await page.locator("[data-scope=menu]").count()).toBe(0)
  await page.close()
})

test("the row menu opens from the keyboard, moves with arrows, and Escape returns focus to its trigger", async () => {
  const page = await list()
  const trigger = page.getByRole("button", { name: "Weekly pipeline review actions" })
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menu").waitFor()
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Run now…", "Edit…", "Run history", "Pause", "Delete…"])
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await page.getByRole("menu").count()).toBe(0)
  expect(await focusedLabel(page)).toBe("Weekly pipeline review actions")
  await page.close()
})

test("Pause from the row menu sends one update and the switch follows its answer", async () => {
  const page = await list()
  await page.getByRole("button", { name: "Weekly pipeline review actions" }).click()
  await page.getByRole("menuitem", { name: "Pause" }).click()
  await settled(page)
  expect(await calls(page)).toContain('automation.update:{"id":"a1","enabled":false}')
  expect(await page.getByRole("switch", { name: "Resume Weekly pipeline review" }).getAttribute("aria-checked")).toBe("false")
  await page.close()
})

test("the on switch is a UI SDK switch that Space toggles once per press", async () => {
  const page = await list()
  const on = page.getByRole("switch", { name: "Pause Weekly pipeline review" })
  expect(await on.getAttribute("aria-checked")).toBe("true")
  await on.focus()
  await page.keyboard.press("Space")
  await settled(page)
  expect(await count(page, "automation.update")).toBe(1)
  const off = page.getByRole("switch", { name: "Resume Weekly pipeline review" })
  expect(await off.getAttribute("aria-checked")).toBe("false")
  await off.press("Space")
  await settled(page)
  expect((await calls(page)).filter((call) => call.startsWith("automation.update"))).toEqual([
    'automation.update:{"id":"a1","enabled":false}',
    'automation.update:{"id":"a1","enabled":true}',
  ])
  await page.close()
})

test("Edit's project select, target segments and cron presets work from the keyboard", async () => {
  const page = await list()
  await page.getByRole("button", { name: "Weekly pipeline review actions" }).click()
  await page.getByRole("menuitem", { name: "Edit…" }).click()
  await settled(page)
  const dialog = page.getByRole("dialog", { name: "Edit automation" })
  const project = dialog.getByRole("combobox", { name: "Project" })
  expect(await project.textContent()).toContain("Atlas")
  await project.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("option", { name: "Ledger" }).waitFor()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await project.textContent()).toContain("Ledger")

  const fresh = dialog.getByRole("radio", { name: "New thread" })
  expect(await fresh.getAttribute("aria-checked")).toBe("true")
  await fresh.focus()
  await page.keyboard.press("ArrowRight")
  expect(await dialog.getByRole("radio", { name: "Standing thread" }).getAttribute("aria-checked")).toBe("true")

  const cron = dialog.getByRole("textbox", { name: "Cron" })
  const mondays = dialog.getByRole("radio", { name: "Mondays 9:00" })
  expect(await mondays.getAttribute("aria-checked")).toBe("true")
  await mondays.focus()
  await page.keyboard.press("ArrowLeft")
  expect(await cron.inputValue()).toBe("0 9 * * 1-5")
  await cron.fill("15 3 * * *")
  expect(await dialog.getByRole("radiogroup", { name: "Schedule preset" }).locator("[aria-checked=true]").count()).toBe(0)
  await page.close()
})

test("run history pages with Previous · N of M · Next, one request per new page and none going back", async () => {
  const page = await history(45)
  const label = page.getByTestId("run-page")
  expect(await runRows(page).count()).toBe(20)
  expect(await label.textContent()).toBe("Page 1")
  expect(await page.getByRole("button", { name: "Previous" }).isDisabled()).toBe(true)
  const next = page.getByRole("button", { name: "Next" })
  await next.click()
  await settled(page)
  expect(await count(page, "automation.runs")).toBe(1)
  expect(await label.textContent()).toBe("Page 2")
  await next.click()
  await settled(page)
  expect(await count(page, "automation.runs")).toBe(2)
  expect(await runRows(page).count()).toBe(5)
  expect(await label.textContent()).toBe("3 of 3")
  expect(await next.isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Previous" }).click()
  await page.getByRole("button", { name: "Previous" }).click()
  expect(await label.textContent()).toBe("1 of 3")
  await next.click()
  expect(await label.textContent()).toBe("2 of 3")
  expect(await count(page, "automation.runs")).toBe(2)
  expect(await count(page, "automation.get")).toBe(1)
  await page.close()
})

test("a full last page that turns out to be the end keeps the pager and disables Next after one empty request", async () => {
  const page = await history(20)
  expect(await page.getByTestId("run-page").textContent()).toBe("Page 1")
  await page.getByRole("button", { name: "Next" }).click()
  await settled(page)
  expect(await count(page, "automation.runs")).toBe(1)
  expect(await page.getByTestId("run-page").textContent()).toBe("1 of 1")
  expect(await page.getByRole("button", { name: "Next" }).isDisabled()).toBe(true)
  await page.close()
})

test("a short history shows no pager", async () => {
  const page = await history(6)
  expect(await runRows(page).count()).toBe(6)
  expect(await page.getByRole("navigation", { name: "Run pages" }).count()).toBe(0)
  expect(await page.getByText("That's every run.").count()).toBe(1)
  await page.close()
})

test("a run row is a collapsible that Enter opens and closes", async () => {
  const page = await history(6)
  const trigger = runRows(page).first().locator("[data-slot=collapsible-trigger]")
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await trigger.focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await trigger.getAttribute("aria-expanded")).toBe("true")
  expect(await runRows(page).first().getByText("run-00").isVisible()).toBe(true)
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await trigger.getAttribute("aria-expanded")).toBe("false")
  await page.close()
})

test("a burst of revision bumps reloads the open automation once, after the debounce", async () => {
  const page = await history(6)
  await page.evaluate(() => {
    const bump = (window as unknown as { bump: () => void }).bump
    bump()
    bump()
    bump()
  })
  await page.waitForTimeout(150)
  expect(await count(page, "automation.get")).toBe(1)
  await page.waitForTimeout(600)
  expect(await count(page, "automation.get")).toBe(2)
  await page.close()
})

for (const [label, reduce] of [
  ["the OS setting", (page: Page) => page.emulateMedia({ reducedMotion: "reduce" })],
  ["the Appearance setting", (page: Page) => page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduce"))],
] as const) {
  test(`under reduced motion from ${label} the switch thumb does not slide`, async () => {
    const page = await list()
    await reduce(page)
    const duration = await page
      .locator("[data-slot=switch-thumb]")
      .first()
      .evaluate((thumb) => getComputedStyle(thumb).transitionDuration)
    expect(duration).toBe("0s")
    await page.close()
  })
}
