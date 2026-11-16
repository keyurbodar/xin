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

type Fixture = {
  readonly tl: {
    readonly run: (count: number) => void
    readonly finish: () => void
    readonly blockVisuals: () => void
    readonly longer: () => void
    readonly stopWaiting: () => void
  }
}

const settled = (page: Page) => page.waitForTimeout(400)
const tl = (page: Page, call: (fixture: Fixture["tl"]) => void) =>
  page.evaluate(`(${call.toString()})(window.tl)`)
const groupButtons = (page: Page) => page.locator("[data-tool-group] > ui-collapsible-trigger > button")
const expanded = (page: Page) =>
  groupButtons(page).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-expanded")))
const scrollTop = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>("[data-timeline]")!.scrollTop)

test("a group opens and closes from the keyboard, and so does each step", async () => {
  const page = await harness.open("timeline")
  const group = groupButtons(page).first()
  expect(await group.getAttribute("aria-expanded")).toBe("false")
  await group.focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await group.getAttribute("aria-expanded")).toBe("true")
  expect(await page.locator("[data-step=c1]").isVisible()).toBe(true)
  await page.keyboard.press("Tab")
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.locator("[data-step=c1]").getByText("src/auth.ts", { exact: false }).count()).toBeGreaterThan(1)
  expect(await page.locator("[data-step=c1] pre").first().isVisible()).toBe(true)
  await group.focus()
  await page.keyboard.press("Space")
  await settled(page)
  expect(await group.getAttribute("aria-expanded")).toBe("false")
  expect(await page.locator("[data-step=c1]").isVisible()).toBe(false)
  await page.close()
})

test("the summary counts each kind and marks a failed step", async () => {
  const page = await harness.open("timeline")
  const labels = await groupButtons(page).allInnerTexts()
  expect(labels.slice(0, 3)).toEqual(["Searched 1 time, read 2 files, ran 1 command, 1 failed", "Made 1 edit, started 1 thread", "Sent 1 message"])
  expect(await page.locator("[data-tool-group][data-status=error]").count()).toBe(1)
  await page.close()
})

test("the live turn's groups stay open while it works and collapse when it ends", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.run(6))
  await groupButtons(page).first().click()
  await settled(page)
  expect(await expanded(page)).toEqual(["true", "false", "false", "true"])
  expect(await page.locator("[data-tool-group]").last().getAttribute("data-status")).toBe("running")
  await tl(page, (fixture) => fixture.finish())
  await settled(page)
  expect((await expanded(page)).every((value) => value === "false")).toBe(true)
  expect(await page.locator("[data-turn-summary]").last().innerText()).toBe("Worked for 1m 27s")
  await page.close()
})

test("sending the next message collapses the open groups", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.run(5))
  await settled(page)
  expect((await expanded(page)).at(-1)).toBe("true")
  await page.click("#composer")
  await page.keyboard.type("Also bump the version")
  await page.click("button[type=submit]")
  await settled(page)
  expect((await expanded(page)).every((value) => value === "false")).toBe(true)
  await page.close()
})

test("a tool with a registered block renders the block in its place and draws no step", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.run(8))
  await settled(page)
  expect(await page.locator("[data-step=l3]").count()).toBe(1)
  await tl(page, (fixture) => fixture.blockVisuals())
  await settled(page)
  expect(await page.locator("[data-step=l3]").count()).toBe(0)
  expect(await page.locator("[data-test-block=l3]").innerText()).toBe("Refresh, before and after (running)")
  await tl(page, (fixture) => fixture.finish())
  await settled(page)
  expect(await page.locator("[data-test-block=l3]").innerText()).toBe("Refresh, before and after (done)")
  await page.close()
})

test("scrolled up, new content keeps the view still and raises the jump pill, which Enter follows", async () => {
  const page = await harness.open("timeline")
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("[data-timeline]")!.scrollTop = 200
  })
  await settled(page)
  expect(await page.locator("[data-jump]").count()).toBe(0)
  const anchor = await page.getByText("Both threads are done", { exact: false }).boundingBox()
  await tl(page, (fixture) => fixture.run(4))
  await tl(page, (fixture) => fixture.finish())
  await settled(page)
  expect(await scrollTop(page)).toBe(200)
  const after = await page.getByText("Both threads are done", { exact: false }).boundingBox()
  expect(Math.abs((after?.y ?? 0) - (anchor?.y ?? 0))).toBeLessThan(2)
  const pill = page.locator("[data-jump]")
  expect(await pill.innerText()).toBe("3 messages")
  await pill.focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.locator("[data-jump]").count()).toBe(0)
  expect(
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-timeline]")!
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    }),
  ).toBeLessThan(2)
  await page.close()
})

test("pinned to the end, streaming follows the newest line", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.finish())
  await tl(page, (fixture) => fixture.longer())
  await settled(page)
  expect(await page.locator("[data-jump]").count()).toBe(0)
  expect(
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-timeline]")!
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    }),
  ).toBeLessThan(2)
  await page.close()
})

test("the waiting line names what the agent waits on", async () => {
  const page = await harness.open("timeline")
  const waiting = page.locator("[data-waiting]")
  expect(await waiting.innerText()).toBe("Waiting on Release notes")
  expect(await waiting.getAttribute("role")).toBe("status")
  await tl(page, (fixture) => fixture.run(5))
  await settled(page)
  expect(await waiting.innerText()).toBe("Waiting on bash")
  await tl(page, (fixture) => fixture.run(1))
  await tl(page, (fixture) => fixture.finish())
  await tl(page, (fixture) => fixture.stopWaiting())
  await settled(page)
  expect(await waiting.count()).toBe(0)
  await page.close()
})

test("dates divide the turns as separators", async () => {
  const page = await harness.open("timeline")
  const dividers = page.getByRole("separator")
  expect(await dividers.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")))).toEqual(["Yesterday", "Today"])
  await page.close()
})
