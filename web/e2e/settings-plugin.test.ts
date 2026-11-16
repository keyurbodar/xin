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

test("a plugin Settings page that throws shows its fallback and leaves Settings standing", async () => {
  const page = await harness.open("settings-plugin", {
    before: (page) =>
      page.route("**/v1/cmd", (route) => {
        const frames: unknown = route.request().postDataJSON()
        const ids = (Array.isArray(frames) ? frames : [frames]).map((frame: { id: string }) => frame.id)
        const acks = ids.map((id) => ({ id, ok: false, error: { code: "unavailable", message: "no backend in this fixture" } }))
        return route.fulfill({ json: Array.isArray(frames) ? acks : acks[0] })
      }),
  })
  expect(await page.locator("#steady").textContent()).toBe("steady body")
  await page.getByRole("button", { name: "Broken settings" }).click()
  expect(await page.getByRole("heading", { name: "Broken settings" }).isVisible()).toBe(true)
  expect(await page.getByText("broken failed to render").isVisible()).toBe(true)
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Plugins" }).click()
  expect(await page.getByRole("heading", { name: "Plugins" }).isVisible()).toBe(true)
  await page.close()
})
