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

test("a plugin Settings page that throws shows its fallback and leaves the next page and Settings standing", async () => {
  const page = await harness.open("settings-plugin", {
    before: (page) =>
      page.route("**/v1/cmd", (route) => {
        const frames: unknown = route.request().postDataJSON()
        const ids = (Array.isArray(frames) ? frames : [frames]).map((frame: { id: string }) => frame.id)
        const acks = ids.map((id) => ({ id, ok: false, error: { code: "unavailable", message: "no backend in this fixture" } }))
        return route.fulfill({ json: Array.isArray(frames) ? acks : acks[0] })
      }),
  })
  try {
    const plugins = page.getByRole("navigation", { name: "Settings" })
    await page.locator("#steady").waitFor()
    await plugins.getByRole("link", { name: "Broken settings" }).click()
    await page.getByRole("heading", { name: "Broken settings" }).waitFor()
    await page.getByText("broken failed to render").waitFor()
    await plugins.getByRole("link", { name: "Steady settings" }).click()
    await page.getByRole("heading", { name: "Steady settings" }).waitFor()
    expect(await page.locator("#steady").textContent()).toBe("steady body")
    expect(await page.getByText("failed to render").count()).toBe(0)
    await plugins.getByRole("link", { name: "Plugins" }).click()
    await page.getByRole("heading", { name: "Plugins" }).waitFor()
  } finally {
    await page.close()
  }
})
