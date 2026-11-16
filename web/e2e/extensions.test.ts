import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(60_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

test("picking a second skill while /v1/cmd is slow keeps the tabs and the skill list mounted, with no screen skeleton", async () => {
  const page = await harness.open("extensions")
  await page.getByRole("button", { name: "Skills", exact: false }).first().click()
  await page.getByRole("button", { name: /release-notes/ }).click()
  await page.getByText("The body of release-notes.").waitFor()
  await page.evaluate(() => {
    const marked = window as unknown as { tabs: Element | null; list: Element | null; skeletons: number }
    marked.tabs = document.querySelector("header")
    marked.list = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("triage")) ?? null
    marked.skeletons = 0
    ;(window as unknown as { suspended: string[] }).suspended.length = 0
    new MutationObserver(() => {
      if (document.querySelector(".im-skeleton") !== null) marked.skeletons += 1
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.getByRole("button", { name: /triage/ }).click()
  await page.getByText("The body of triage.").waitFor()
  const state = await page.evaluate(() => {
    const marked = window as unknown as { tabs: Element | null; list: Element | null; skeletons: number; suspended: string[] }
    return {
      tabs: marked.tabs !== null && marked.tabs.isConnected,
      list: marked.list !== null && marked.list.isConnected,
      skeletons: marked.skeletons,
      suspended: marked.suspended,
    }
  })
  expect(state).toEqual({ tabs: true, list: true, skeletons: 0, suspended: [] })
  await page.close()
})
