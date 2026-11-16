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
    readonly reconnect: () => void
    readonly paginate: () => void
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
  expect(labels.slice(0, 3)).toEqual(["Searched 1 time, read 2 files, ran 1 command, 1 failed", "Made 1 edit", "Sent 1 message"])
  expect(await page.locator("[data-tool-group][data-status=error]").count()).toBe(1)
  await page.close()
})

test("the live turn's groups stay open while it works and fold when it ends, keeping what the owner opened", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.run(6))
  await groupButtons(page).first().click()
  await settled(page)
  expect(await expanded(page)).toEqual(["true", "false", "false", "true"])
  expect(await page.locator("[data-tool-group]").last().getAttribute("data-status")).toBe("running")
  await tl(page, (fixture) => fixture.finish())
  await settled(page)
  expect(await expanded(page)).toEqual(["true", "false", "false", "false"])
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
  const announcer = page.locator("[data-jump-status]")
  expect(await announcer.getAttribute("aria-live")).toBe("polite")
  expect(await announcer.textContent()).toBe("3 new messages")
  await pill.focus()
  await page.keyboard.press("Enter")
  await settled(page)
  expect(await page.locator("[data-jump]").count()).toBe(0)
  expect(await page.locator("[data-jump-status]").textContent()).toBe("")
  expect(
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("[data-timeline]")!
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    }),
  ).toBeLessThan(2)
  await page.close()
})

test("a streamed token touches only the message it lands in, never the tool groups", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.run(10))
  await settled(page)
  await page.evaluate(() => {
    const counts = { groups: 0, text: 0 }
    const watch = (selector: string, key: keyof typeof counts) => {
      for (const node of document.querySelectorAll(selector))
        new MutationObserver((records) => {
          counts[key] += records.length
        }).observe(node, { subtree: true, childList: true, characterData: true, attributes: true })
    }
    watch("[data-tool-group]", "groups")
    watch("[data-text]", "text")
    Object.assign(window, { counts })
  })
  await tl(page, (fixture) => fixture.run(1))
  await settled(page)
  const counts = await page.evaluate(() => (window as unknown as { counts: { groups: number; text: number } }).counts)
  expect(counts.groups).toBe(0)
  expect(counts.text).toBeGreaterThan(0)
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
  expect(await waiting.textContent()).toBe("Waiting on Release notes")
  expect(await waiting.getAttribute("role")).toBe("status")
  await tl(page, (fixture) => fixture.run(5))
  await settled(page)
  expect(await waiting.textContent()).toBe("Waiting on bash")
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

test("delegate_task renders as the thread fan in its place, and thread names are link chips", async () => {
  const page = await harness.open("timeline")
  expect(await page.locator("[data-block=c6]").innerText()).toContain("Regression tests")
  expect(await page.locator("[data-step=c6]").count()).toBe(0)
  const chip = page.locator("[data-turn-summary] a[data-kind=thread]").first()
  expect(await chip.innerText()).toBe("Regression tests")
  expect(await chip.getAttribute("href")).toBe("#/p/auth/t/23")
  expect(await page.locator("[data-waiting] a[data-kind=thread]").innerText()).toBe("Release notes")
  await page.close()
})

test("a reconnect that re-parses the same entries leaves the DOM, the blocks and the scroll alone", async () => {
  const page = await harness.open("timeline")
  await tl(page, (fixture) => fixture.blockVisuals())
  await tl(page, (fixture) => fixture.run(8))
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("[data-timeline]")!.scrollTop = 300
    Object.assign(window, { held: [document.querySelector("[data-block=c6]")?.firstElementChild, document.querySelector("[data-test-block=l3]")] })
  })
  await settled(page)
  await page.evaluate(() => {
    const counts = { mutations: 0 }
    new MutationObserver((records) => {
      counts.mutations += records.filter((record) => record.target instanceof Element && record.target.closest("[data-item]") !== null).length
    }).observe(document.querySelector("[data-timeline]")!, { subtree: true, childList: true, characterData: true, attributes: true })
    Object.assign(window, { counts })
  })
  await tl(page, (fixture) => fixture.reconnect())
  await settled(page)
  expect(await page.evaluate(() => (window as unknown as { counts: { mutations: number } }).counts.mutations)).toBe(0)
  expect(await scrollTop(page)).toBe(300)
  expect(
    await page.evaluate(() => {
      const [fan, block] = (window as unknown as { held: (Element | null | undefined)[] }).held
      return [fan?.isConnected, block?.isConnected, fan === document.querySelector("[data-block=c6]")?.firstElementChild]
    }),
  ).toEqual([true, true, true])
  await page.close()
})

test("loading older pages of the same day keeps what was on screen where it was", async () => {
  const page = await harness.open("timeline")
  await page.setViewportSize({ width: 1280, height: 480 })
  await tl(page, (fixture) => fixture.paginate())
  await settled(page)
  const marker = page.getByText("Added refresh.parallel.test.ts", { exact: false })
  for (const round of [1, 2]) {
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("[data-timeline]")!.scrollTop = 0
    })
    await settled(page)
    const before = (await marker.boundingBox())!.y
    await page.click("[data-load-older]")
    await settled(page)
    expect(await page.getByText("Everything is green", { exact: false }).count()).toBe(round)
    expect(Math.abs((await marker.boundingBox())!.y - before)).toBeLessThanOrEqual(1)
  }
  expect(await page.getByRole("separator", { name: "Today" }).count()).toBe(1)
  await page.close()
})
