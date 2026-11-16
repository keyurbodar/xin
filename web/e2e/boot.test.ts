import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(90_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

test("a startup chunk that fails retries once with a cache-bust, then shows Reload, which boots once the chunk is back", async () => {
  const page = await harness.newPage()
  try {
    const loads: string[] = []
    page.on("request", (request) => {
      if (request.resourceType() === "document") loads.push(request.url())
    })
    await page.route("**/src/main.tsx", (route) => route.abort())
    await page.goto(`${harness.origin}/index.html`)
    const alert = page.getByRole("alert")
    await alert.waitFor()
    expect(await alert.innerText()).toContain("Ingle didn't load")
    expect(loads).toHaveLength(2)
    expect(new URL(loads[1] ?? "").searchParams.has("boot")).toBe(true)
    const reload = alert.getByRole("button", { name: "Reload" })
    expect(await reload.evaluate((button) => button === document.activeElement)).toBe(true)
    await page.unroute("**/src/main.tsx")
    await reload.click()
    await page.waitForFunction(() => Reflect.get(window, "ingleBooted") === true)
    expect(await page.getByRole("alert").filter({ hasText: "Ingle didn't load" }).count()).toBe(0)
    expect(new URL(page.url()).searchParams.has("boot")).toBe(false)
    expect(await page.evaluate(() => sessionStorage.getItem("ingle.boot.retry"))).toBeNull()
  } finally {
    await page.close()
  }
})

test("a page that boots never shows the fallback and leaves no retry flag", async () => {
  const page = await harness.newPage()
  try {
    await page.goto(`${harness.origin}/index.html?boot=1`)
    await page.waitForFunction(() => Reflect.get(window, "ingleBooted") === true)
    expect(await page.locator("#boot-failed").count()).toBe(0)
    expect(new URL(page.url()).searchParams.has("boot")).toBe(false)
  } finally {
    await page.close()
  }
})
