import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import type { Page } from "playwright"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(90_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

const MISSING = /Failed to load resource: the server responded with a status of 404/

async function open(hash: string, chunks: readonly string[]): Promise<{ page: Page; errors: string[]; restore: () => Promise<void> }> {
  const errors: string[] = []
  const patterns = chunks.map((chunk) => `**/src/${chunk}*`)
  const page = await harness.open("chunks", {
    search: hash,
    expected: MISSING,
    before: async (page) => {
      page.on("pageerror", (error) => errors.push(String(error)))
      for (const pattern of patterns) await page.route(pattern, (route) => route.fulfill({ status: 404, body: "gone" }))
    },
  })
  return {
    page,
    errors,
    restore: async () => {
      for (const pattern of patterns) await page.unroute(pattern)
    },
  }
}

test("a welcome chunk that fails offers Try again, raises nothing uncaught, and recovers once the chunk is back", async () => {
  const { page, errors, restore } = await open("#/welcome", ["screens/welcome.tsx"])
  const stopped = page.getByRole("alert")
  await stopped.waitFor()
  expect(await stopped.innerText()).toContain("Setup didn't load")
  expect(await page.getByText("Starting Ingle").count()).toBe(0)
  await restore()
  await stopped.getByRole("button", { name: "Try again" }).click()
  await page.getByText("Connect a model provider").waitFor()
  expect(await page.getByRole("alert").count()).toBe(0)
  expect(errors).toEqual([])
  await page.close()
})

test("a pane view chunk that fails stops only the pane, and Try again retries just the pane", async () => {
  const { page, errors, restore } = await open("#/p/atlas", ["components/pane/drive.tsx"])
  const composer = page.getByRole("textbox", { name: /^Message/ }).first()
  await composer.waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as { setPaneOpen: (open: boolean) => void; showPaneView: (project: string, view: string) => void }
    fixture.setPaneOpen(true)
    fixture.showPaneView("p1", "files")
  })
  const pane = page.locator("aside").last()
  const stopped = pane.getByRole("alert")
  await stopped.waitFor()
  expect(await stopped.innerText()).toContain("This view stopped")
  expect(await page.getByRole("alert").count()).toBe(1)
  expect(await pane.getByRole("button", { name: "Hide the pane" }).isEnabled()).toBe(true)
  await composer.fill("still typing")
  expect((await composer.innerText()).trim()).toBe("still typing")
  expect(await page.getByRole("button", { name: "Extensions" }).first().isEnabled()).toBe(true)
  await restore()
  await stopped.getByRole("button", { name: "Try again" }).click()
  await page.waitForFunction(() => (window as unknown as { calls: string[] }).calls.includes("drive.scopes"))
  expect(await page.getByRole("alert").count()).toBe(0)
  expect((await composer.innerText()).trim()).toBe("still typing")
  expect(errors).toEqual([])
  await page.close()
})

test("after a screen chunk fails, navigating renders the next route, and Try again recovers the failed one", async () => {
  const { page, errors, restore } = await open("#/settings", ["screens/settings.tsx"])
  const stopped = page.getByRole("alert")
  await stopped.waitFor()
  expect(await stopped.innerText()).toContain("This screen stopped")
  await page.getByRole("button", { name: "Extensions" }).first().click()
  await page.getByRole("link", { name: "Explore", exact: true }).first().waitFor()
  expect(await page.getByRole("alert").count()).toBe(0)
  await page.getByRole("button", { name: "Settings" }).first().click()
  await stopped.waitFor()
  await restore()
  await stopped.getByRole("button", { name: "Try again" }).click()
  await page.getByText("Profile + token").waitFor()
  expect(await page.getByRole("alert").count()).toBe(0)
  expect(errors).toEqual([])
  await page.close()
})
