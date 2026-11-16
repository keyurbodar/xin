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

const COMBOBOX = /ui-sdk_web_combobox|@ui-sdk\/web\/dist\/combobox/
const SETTINGS = /\/src\/screens\/settings\.tsx/
const TOKEN_INPUT = /ui-sdk_web_token-input|@ui-sdk\/web\/dist\/token-input/

type Booted = {
  readonly page: Page
  readonly errors: string[]
  readonly reloads: () => number
  readonly misses: () => number
}

async function boot(
  gone: RegExp,
): Promise<Booted & { readonly lose: () => Promise<void>; readonly restore: () => Promise<void> }> {
  const page = await harness.open("chunks", { search: "#/p/atlas" })
  const errors: string[] = []
  let loads = 0
  let misses = 0
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("load", () => loads++)
  await page
    .getByRole("textbox", { name: /^Message/ })
    .first()
    .waitFor()
  return {
    page,
    errors,
    reloads: () => loads,
    misses: () => misses,
    lose: async () => {
      await page.route(gone, (route) => {
        misses++
        return route.fulfill({ status: 404, body: "gone" })
      })
    },
    restore: () => page.unroute(gone),
  }
}

async function rebooted(page: Page): Promise<string> {
  await page.waitForURL(/[?&]stale=\d+/)
  await page.waitForFunction(() => document.body.dataset.ready === "1")
  return new URL(page.url()).searchParams.get("stale") ?? ""
}

const picker = (page: Page) => page.getByRole("button", { name: /^Model:/ }).first()

test("a combobox chunk gone after a redeploy reloads the page once with ?stale=, and a second miss leaves the picker to retry on the next press", async () => {
  const { page, errors, reloads, misses, lose, restore } = await boot(COMBOBOX)
  try {
    await lose()
    await picker(page).click()
    const guard = await rebooted(page)
    expect(reloads()).toBe(1)
    await picker(page).click()
    await page.waitForFunction(() => document.readyState === "complete")
    await page.waitForTimeout(1500)
    expect(misses()).toBeGreaterThanOrEqual(2)
    expect(reloads()).toBe(1)
    expect(new URL(page.url()).searchParams.get("stale")).toBe(guard)
    await restore()
    await picker(page).click()
    await page.getByPlaceholder("Search models").waitFor()
    expect(reloads()).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("a screen chunk gone after boot reloads once, and the second miss shows Try again in place", async () => {
  const { page, errors, reloads, lose, restore } = await boot(SETTINGS)
  try {
    await lose()
    await page.getByRole("button", { name: "Settings" }).first().click()
    await rebooted(page)
    const stopped = page.getByRole("alert")
    await stopped.waitFor()
    expect(await stopped.innerText()).toContain("This screen stopped")
    await page.waitForTimeout(1500)
    expect(reloads()).toBe(1)
    await restore()
    await stopped.getByRole("button", { name: "Try again" }).click()
    await page.getByText("Profile + token").waitFor()
    expect(reloads()).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("an unsent draft holds the reload until the composer is empty, then the next press reloads", async () => {
  const { page, errors, reloads, misses, lose } = await boot(COMBOBOX)
  try {
    const composer = page.getByRole("textbox", { name: /^Message/ }).first()
    await composer.fill("not sent yet")
    await lose()
    await picker(page).click()
    await page.waitForTimeout(1500)
    expect(misses()).toBeGreaterThanOrEqual(1)
    expect(reloads()).toBe(0)
    expect(page.url()).not.toContain("stale=")
    expect((await composer.innerText()).trim()).toBe("not sent yet")
    await composer.fill("")
    await picker(page).click()
    await rebooted(page)
    expect(reloads()).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})

test("a chunk that throws while it evaluates fails in place without reloading", async () => {
  const { page, reloads } = await boot(SETTINGS)
  try {
    await page.route(SETTINGS, (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: 'throw new Error("settings blew up")' }),
    )
    await page.getByRole("button", { name: "Settings" }).first().click()
    const stopped = page.getByRole("alert")
    await stopped.waitFor()
    expect(await stopped.innerText()).toContain("settings blew up")
    await page.waitForTimeout(1500)
    expect(reloads()).toBe(0)
    expect(page.url()).not.toContain("stale=")
  } finally {
    await page.close()
  }
})

test("a composer editor chunk that fails once the reload is spent stops only the message box with Try again, raising nothing uncaught", async () => {
  const errors: string[] = []
  const page = await harness.open("chunks", {
    search: `?stale=${Date.now()}#/p/atlas`,
    expected: /Failed to load resource: the server responded with a status of 404/,
    before: async (page) => {
      page.on("pageerror", (error) => errors.push(String(error)))
      await page.route(TOKEN_INPUT, (route) => route.fulfill({ status: 404, body: "gone" }))
    },
  })
  try {
    const stopped = page.getByRole("alert")
    await stopped.waitFor()
    expect(await stopped.innerText()).toContain("The message box didn't load")
    expect(await stopped.count()).toBe(1)
    await page.unroute(TOKEN_INPUT)
    await stopped.getByRole("button", { name: "Try again" }).click()
    await page
      .getByRole("textbox", { name: /^Message/ })
      .first()
      .waitFor()
    expect(await page.getByRole("alert").count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await page.close()
  }
})
