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

type Call = { readonly op: string; readonly args: Record<string, unknown> }
const calls = (page: Page): Promise<readonly Call[]> => page.evaluate(() => Reflect.get(window, "calls"))
const created = async (page: Page): Promise<Record<string, unknown> | undefined> =>
  (await calls(page)).find((call) => call.op === "captain.create")?.args

async function openDialog(width = 1280): Promise<Page> {
  const page = await harness.open("new-captain", { width })
  await page.click("#open")
  await page.getByRole("dialog").waitFor()
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("ui-combobox-input input")?.value === "Fixture Large")
  return page
}

const createButton = (page: Page) => page.getByRole("button", { name: /Create Captain/ })

test("the dialog shows only what captain.create takes and starts on the coordinator's model", async () => {
  const page = await openDialog()
  const dialog = page.getByRole("dialog")
  const text = (await dialog.textContent()) ?? ""
  expect(text).toContain("Project")
  expect(text).toContain("Model")
  for (const missing of ["Machine", "Access", "subscriber", "Owner"]) expect(text).not.toContain(missing)
  expect(await createButton(page).isDisabled()).toBe(true)
  await page.getByLabel("Name").fill("Harbour")
  await page.getByLabel("Goal").fill("Keep the docs site in step with the code.")
  expect(await dialog.locator("[aria-hidden=true]", { hasText: /^H$/u }).count()).toBe(1)
  await createButton(page).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await created(page)).toEqual({
    projectId: "p1",
    name: "Harbour",
    model: { provider: "anthropic", modelId: "fixture-large" },
    description: "Keep the docs site in step with the code.",
  })
  expect(await page.evaluate(() => location.hash)).toBe("#/c/harbour")
  await page.close()
})

test("a project whose coordinator has no model waits for a model found by search", async () => {
  const page = await openDialog()
  await page.locator("ui-select-trigger button").click()
  await page.getByRole("option", { name: "Ledger" }).click()
  await page.getByText("coordinator has no model yet").waitFor()
  await page.getByLabel("Name").fill("Ledger keeper")
  expect(await createButton(page).isDisabled()).toBe(true)
  const search = page.getByRole("combobox", { name: "Model" })
  await search.fill("fixture")
  await page.getByRole("option", { name: "Fixture Flash" }).waitFor()
  expect(await page.getByRole("option", { name: "Fixture Locked" }).count()).toBe(0)
  await search.fill("flash")
  await page.waitForTimeout(300)
  expect(await page.getByRole("option").allTextContents()).toEqual(["Fixture Flash"])
  await page.getByRole("option", { name: "Fixture Flash" }).click()
  expect(await createButton(page).isDisabled()).toBe(false)
  await page.getByLabel("Name").press("Control+Enter")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await created(page)).toEqual({ projectId: "p2", name: "Ledger keeper", model: { provider: "deepseek", modelId: "fixture-flash" } })
  await page.close()
})

test("alias and rules stay folded until opened and go into captain.create", async () => {
  const page = await openDialog()
  expect(await page.getByLabel("Alias").isVisible()).toBe(false)
  await page.getByRole("button", { name: /Alias and rules/ }).click()
  await page.getByLabel("Alias").fill("dock")
  await page.getByRole("textbox", { name: /^Rules/u }).fill("Report every evening.")
  await page.getByLabel("Name").fill("Harbour")
  await createButton(page).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(await created(page)).toMatchObject({ alias: "dock", rules: "Report every evening." })
  expect(await page.evaluate(() => location.hash)).toBe("#/c/dock")
  await page.close()
})

test("a new Captain's empty chat shows who it is and sends a starter through message.send", async () => {
  const page = await harness.open("new-captain", { search: "?view=welcome" })
  const welcome = page.getByRole("region", { name: "Start with Harbour" })
  await welcome.waitFor()
  expect(await welcome.getByRole("heading").textContent()).toBe("Harbour")
  expect(await welcome.textContent()).toContain("Keep the docs site in step with the code.")
  const starters = welcome.getByRole("button")
  expect(await starters.count()).toBe(4)
  await starters.first().click()
  await welcome.waitFor({ state: "detached" })
  const sent = (await calls(page)).filter((call) => call.op === "message.send")
  expect(sent).toHaveLength(1)
  expect(sent[0]?.args).toMatchObject({ conv: 9, text: "Plan the first week" })
  expect(typeof sent[0]?.args.clientTs).toBe("number")
  await page.getByText("Plan the first week").waitFor()
  await page.close()
})

test("the dialog and the empty chat fit a phone without sideways scroll", async () => {
  const page = await openDialog(390)
  const overflow = (selector: string) =>
    page.evaluate((query) => {
      const element = document.querySelector(query)
      return element === null ? -1 : element.scrollWidth - element.clientWidth
    }, selector)
  expect(await overflow("ui-dialog-content")).toBe(0)
  await page.close()
  const chat = await harness.open("new-captain", { search: "?view=welcome", width: 390 })
  await chat.getByRole("region", { name: "Start with Harbour" }).waitFor()
  expect(await chat.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await chat.close()
})
