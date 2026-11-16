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

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls)
const section = (page: Page, label: string) => page.getByRole("region", { name: label, exact: true })

test("Overview shows in-progress issues with priority over age, threads with their pull requests, linked pull requests and a Drive strip", async () => {
  const page = await harness.open("pane-overview")
  await page.getByText("acme/atlas #81").waitFor()
  const headers = await page.locator("aside button[aria-expanded]:not([aria-label])").allTextContents()
  expect(headers.map((text) => text.replace(/\d+$/u, "").trim())).toEqual(["In progress", "Threads", "Pull requests", "Drive"])
  const progress = section(page, "In progress")
  expect(await progress.getByText("Port the dialog shell").count()).toBe(1)
  expect(await progress.getByText("Review queue for the crew").count()).toBe(1)
  expect(await progress.getByText("Plan the release notes").count()).toBe(0)
  const side = progress.locator("button", { hasText: "Port the dialog shell" }).locator("span.flex-col.items-end")
  expect(await side.locator("svg").count()).toBe(1)
  expect((await side.innerText()).trim()).toBe("1m")
  const threads = section(page, "Threads")
  expect(await threads.locator("button", { hasText: "Web UI on the new primitives" }).innerText()).toContain("2 PRs")
  expect(await threads.locator("button", { hasText: "Captains and crews" }).innerText()).toContain("1 PR")
  expect(await section(page, "Pull requests").locator("a").count()).toBe(4)
  const strip = page.getByRole("list", { name: "Newest files" })
  expect(await strip.getByRole("listitem").count()).toBe(8)
  expect(await strip.getByRole("button", { name: "Show more" }).count()).toBe(1)
  await strip.getByRole("listitem").filter({ hasText: "poster.png" }).scrollIntoViewIfNeeded()
  await strip.getByRole("listitem").filter({ hasText: "bubble.png" }).scrollIntoViewIfNeeded()
  await page.waitForFunction(() => (window as unknown as { calls: string[] }).calls.some((call) => call.startsWith("blob:")))
  expect(await strip.getByRole("listitem").filter({ hasText: "poster.png" }).locator("[data-slot=tile]").count()).toBe(0)
  expect((await calls(page)).filter((call) => call.startsWith("blob:")).every((call) => call !== "blob:renders-poster-png")).toBe(true)
  expect((await calls(page)).filter((call) => call === "issue.list").length).toBe(1)
  await page.close()
})

test("a Drive tile opens its file as a pane tab, back closes the tab, and Show more opens Drive", async () => {
  const page = await harness.open("pane-overview")
  const strip = page.getByRole("list", { name: "Newest files" })
  await strip.getByRole("listitem").filter({ hasText: "XIN-25.md" }).click()
  await page.getByText("The body of reports/XIN-25.md.").waitFor()
  expect(await page.locator("aside").getByText("XIN-25.md", { exact: true }).first().isVisible()).toBe(true)
  await page.getByRole("button", { name: /^Back/ }).first().click()
  await strip.waitFor()
  expect(await page.getByText("The body of reports/XIN-25.md.").count()).toBe(0)
  await strip.getByRole("button", { name: "Show more" }).click()
  await page.getByRole("tree").waitFor()
  await page.close()
})

test("the + menu lists the views, the crew with each thread's pull requests, All threads, then Pull requests with its count", async () => {
  const page = await harness.open("pane-overview")
  await page.getByText("acme/atlas #81").waitFor()
  await page.getByRole("button", { name: "Open a view" }).click()
  const options = (await page.getByRole("option").allInnerTexts()).map((text) => text.replace(/\s+/gu, " ").trim())
  expect(options.slice(0, 6)).toEqual(["Overview", "Drive", "Issues", "Memory", "Automations", "Jobs"])
  expect(options[6]).toContain("Web UI on the new primitives")
  expect(options[6]).toContain("2 PRs")
  expect(options.slice(-2)).toEqual(["All threads 3", "Pull requests 4"])
  await page.getByRole("option", { name: /Pull requests/ }).click()
  await page.locator("aside").getByText("acme/atlas #15").waitFor()
  await page.close()
})

test("an empty project shows Kiko over a Files card that opens Drive, in place of the sections", async () => {
  const page = await harness.open("pane-overview", { search: "?empty" })
  const card = page.getByRole("button", { name: /^Files/ })
  await card.waitFor()
  expect(await page.locator("svg.kiko").count()).toBe(1)
  expect(await page.locator("aside button[aria-expanded]:not([aria-label])").count()).toBe(0)
  await card.click()
  await page.getByText("Nothing in this drive yet").waitFor()
  expect(await page.locator("svg.kiko").count()).toBe(1)
  await page.close()
})

test("pressing the + menu before the issues chunk lands shows a skeleton, then the pull requests once it loads 1 s later", async () => {
  let released = 0
  const page = await harness.open("pane-overview", {
    before: (page) =>
      page.route(/\/components\/pane\/issues\.tsx/u, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        released = Date.now()
        await route.continue()
      }),
  })
  await page.getByRole("button", { name: "Open a view" }).click()
  await page.getByRole("option", { name: /Pull requests/ }).click()
  await page.locator("aside .im-skeleton").first().waitFor()
  await page.locator("aside").getByText("acme/atlas #15").waitFor()
  expect(released).toBeGreaterThan(0)
  expect(await page.locator("aside .im-skeleton").count()).toBe(0)
  await page.close()
})
