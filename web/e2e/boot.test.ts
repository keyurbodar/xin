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
  } finally {
    await page.close()
  }
})

test("with storage disabled, a failed chunk still retries once, keeps the query, and shows Reload", async () => {
  const page = await harness.newPage()
  try {
    await page.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"])
        Object.defineProperty(window, name, {
          get: () => {
            throw new DOMException("denied", "SecurityError")
          },
        })
    })
    const loads: string[] = []
    page.on("request", (request) => {
      if (request.resourceType() === "document") loads.push(request.url())
    })
    await page.route("**/src/main.tsx", (route) => route.abort())
    await page.goto(`${harness.origin}/index.html?q=a%20b#/p/atlas`)
    await page.getByRole("alert").filter({ hasText: "Ingle didn't load" }).waitFor()
    expect(loads).toHaveLength(2)
    const retried = new URL(loads[1] ?? "")
    expect(retried.searchParams.get("q")).toBe("a b")
    expect(retried.searchParams.has("boot")).toBe(true)
  } finally {
    await page.close()
  }
})

test("a page that boots never shows the fallback and strips the boot param without re-encoding the query", async () => {
  const page = await harness.newPage()
  try {
    await page.goto(`${harness.origin}/index.html?q=a%20b&boot=1#/p/atlas`)
    await page.waitForFunction(() => Reflect.get(window, "ingleBooted") === true)
    expect(await page.locator("#boot-failed").count()).toBe(0)
    expect(new URL(page.url()).search).toBe("?q=a%20b")
    expect(new URL(page.url()).hash).toBe("#/p/atlas")
  } finally {
    await page.close()
  }
})

async function withEntryCss(page: Page, failures: number, delay: number): Promise<string[]> {
  const loads: string[] = []
  page.on("request", (request) => {
    if (request.resourceType() === "document") loads.push(request.url())
  })
  await page.route("**/index.html*", async (route) => {
    const response = await route.fetch()
    const html = (await response.text()).replace(
      "</head>",
      '<link rel="stylesheet" href="/entry-under-test.css" /></head>',
    )
    await route.fulfill({ response, body: html })
  })
  let left = failures
  await page.route("**/entry-under-test.css", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (left-- > 0) await route.fulfill({ status: 503, body: "" })
    else await route.fulfill({ status: 200, contentType: "text/css", body: "html { --entry-under-test: 1; }" })
  })
  return loads
}

for (const delay of [0, 400, 1500]) {
  test(`an entry stylesheet that keeps failing after ${delay} ms retries once, then shows Reload, and never loops`, async () => {
    const page = await harness.newPage()
    try {
      const loads = await withEntryCss(page, Number.POSITIVE_INFINITY, delay)
      await page.goto(`${harness.origin}/index.html?q=a%20b`)
      const alert = page.getByRole("alert").filter({ hasText: "Ingle didn't load" })
      await alert.waitFor()
      await page.waitForTimeout(delay + 1000)
      expect(loads).toHaveLength(2)
      expect(new URL(loads[1] ?? "").searchParams.has("boot")).toBe(true)
      expect(
        await alert.getByRole("button", { name: "Reload" }).evaluate((button) => button === document.activeElement),
      ).toBe(true)
    } finally {
      await page.close()
    }
  })
}

test("an entry stylesheet that fails once after 400 ms recovers on the retry with no panel", async () => {
  const page = await harness.newPage()
  try {
    const loads = await withEntryCss(page, 1, 400)
    await page.goto(`${harness.origin}/index.html?q=a%20b`)
    await page.waitForFunction(
      () => !location.search.includes("boot=") && Reflect.get(window, "ingleBooted") === true,
      undefined,
      { timeout: 20_000 },
    )
    expect(loads).toHaveLength(2)
    expect(await page.locator("#boot-failed").count()).toBe(0)
    expect(new URL(page.url()).search).toBe("?q=a%20b")
  } finally {
    await page.close()
  }
})
