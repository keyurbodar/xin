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

const card = (page: Page, text: string) => page.locator("[data-slot=hover-card-content]", { hasText: text })
const shown = (page: Page, text: string) => card(page, text).isVisible()
const tabTo = async (page: Page, href: string) => {
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab")
    if ((await page.evaluate(() => document.activeElement?.getAttribute("href"))) === href) return
  }
  throw new Error(`Tab never reached ${href}`)
}
const active = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id)

test("a link chip's card opens after the pointer rests, shows a skeleton while loading, and closes on leave", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("a[href='#pr-54']")
  await page.waitForTimeout(250)
  expect(await page.locator("[data-slot=hover-card-content]:visible").count()).toBe(0)
  await page.waitForTimeout(300)
  const preview = page.locator("[data-slot=hover-card-content]:visible")
  expect(await preview.getByRole("status", { name: "Loading" }).isVisible()).toBe(true)
  await page.waitForTimeout(700)
  expect(await preview.textContent()).toContain("keyurbodar/xin#54")
  expect(await preview.textContent()).toContain("+114")
  expect(await preview.textContent()).toContain("Merged")
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(450)
  expect(await shown(page, "keyurbodar/xin#54")).toBe(false)
  await page.close()
})

test("the next card opens at once while the last one was just open", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("a[href='#pr-60']")
  await page.waitForTimeout(550)
  expect(await shown(page, "design system v2")).toBe(true)
  await page.hover("a[href='#xin-25']")
  await page.waitForTimeout(250)
  expect(await shown(page, "Web UI v2")).toBe(true)
  expect(await card(page, "Web UI v2").getAttribute("data-warm")).toBe("")
  await page.close()
})

test("a chip removed while its card is open does not leave later cards warm", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("a[href='#ama-24']")
  await page.waitForTimeout(550)
  expect(await shown(page, "Removed while open")).toBe(true)
  await page.evaluate(() => (window as unknown as { drop: () => void }).drop())
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(450)
  await page.hover("a[href='#xin-25']")
  await page.waitForTimeout(250)
  expect(await shown(page, "Web UI v2")).toBe(false)
  await page.waitForTimeout(300)
  expect(await shown(page, "Web UI v2")).toBe(true)
  expect(await card(page, "Web UI v2").getAttribute("data-warm")).toBe(null)
  await page.close()
})

test("a pointer sweep across chips loads only where it rests, and a chip never loads twice", async () => {
  const page = await harness.open("hover-cards")
  const loads = () => page.evaluate(() => (window as unknown as { loads: string[] }).loads.length)
  await page.hover("a[href='#pr-60']")
  await page.waitForTimeout(550)
  expect(await loads()).toBe(1)
  const centre = async (href: string) => {
    const box = (await page.locator(`a[href='${href}']`).boundingBox())!
    return [box.x + box.width / 2, box.y + box.height / 2] as const
  }
  for (const href of ["#xin-25", "#ama-23", "#418f19f"]) {
    const [x, y] = await centre(href)
    await page.mouse.move(x, y)
    await page.waitForTimeout(60)
  }
  const [x, y] = await centre("#tokens")
  await page.mouse.move(x, y)
  await page.waitForTimeout(400)
  expect(await loads()).toBe(2)
  expect(await shown(page, "6.3 KB")).toBe(true)
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(600)
  await page.hover("a[href='#pr-60']")
  await page.waitForTimeout(550)
  expect(await shown(page, "design system v2")).toBe(true)
  expect(await loads()).toBe(2)
  await page.close()
})

test("an open card describes its chip and stops when it closes", async () => {
  const page = await harness.open("hover-cards")
  await tabTo(page, "#ama-23")
  await page.waitForTimeout(550)
  const link = page.locator("a[href='#ama-23']")
  const id = await link.getAttribute("aria-describedby")
  expect(id).not.toBe(null)
  expect(await page.locator(`[id='${id}']`).textContent()).toContain("Hover cards and link chips")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  expect(await link.getAttribute("aria-describedby")).toBe(null)
  await page.close()
})

test("under reduced motion a warm card still opens without animating", async () => {
  for (const reduce of ["media", "setting"] as const) {
    const page = await harness.open("hover-cards")
    if (reduce === "media") await page.emulateMedia({ reducedMotion: "reduce" })
    else await page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduce"))
    await page.hover("a[href='#pr-60']")
    await page.waitForTimeout(550)
    await page.hover("a[href='#xin-25']")
    await page.waitForTimeout(50)
    const warmCard = card(page, "XIN-25")
    expect(await warmCard.getAttribute("data-warm")).toBe("")
    expect(await warmCard.evaluate((element) => getComputedStyle(element).animationDuration)).toBe("0s")
    await page.close()
  }
})

test("a chip whose item changed reloads on its next settle, and an unchanged one does not", async () => {
  const page = await harness.open("hover-cards")
  const loads = () => page.evaluate(() => (window as unknown as { loads: string[] }).loads.length)
  await page.hover("a[href='#pr-7']")
  await page.waitForTimeout(550)
  expect(await shown(page, "Title version 1")).toBe(true)
  expect(await loads()).toBe(1)
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(600)
  await page.evaluate(() => (window as unknown as { bump: () => void }).bump())
  expect(await page.locator("a[href='#pr-7']").textContent()).toContain("xin#7 v2")
  expect(await loads()).toBe(1)
  await page.hover("a[href='#pr-7']")
  await page.waitForTimeout(550)
  expect(await shown(page, "Title version 2")).toBe(true)
  expect(await loads()).toBe(2)
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(600)
  await page.hover("a[href='#pr-7']")
  await page.waitForTimeout(550)
  expect(await shown(page, "Title version 2")).toBe(true)
  expect(await loads()).toBe(2)
  await page.close()
})

test("a card closes 150ms after the pointer leaves, not the SDK's 300ms default", async () => {
  const page = await harness.open("hover-cards")
  const content = page.locator("ui-hover-card-content", { hasText: "design system v2" })
  await page.hover("a[href='#pr-60']")
  await page.waitForTimeout(550)
  expect(await content.getAttribute("data-open")).toBe("")
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(80)
  expect(await content.getAttribute("data-open")).toBe("")
  await page.waitForTimeout(150)
  expect(await content.getAttribute("data-open")).toBe(null)
  await page.close()
})

test("keyboard focus opens a chip's card and Escape closes it", async () => {
  const page = await harness.open("hover-cards")
  await tabTo(page, "#ama-23")
  await page.waitForTimeout(550)
  expect(await shown(page, "Hover cards and link chips")).toBe(true)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  expect(await shown(page, "Hover cards and link chips")).toBe(false)
  expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#ama-23")
  await page.close()
})

test("each chip kind renders its own details", async () => {
  const page = await harness.open("hover-cards")
  const expectations: [string, string[]][] = [
    ["#xin-25", ["XIN-25", "Ingle · Working"]],
    ["#418f19f", ["418f19f", "presets remove only tool extensions"]],
    ["#tokens", ["web/src/styles/tokens.css", "6.3 KB"]],
  ]
  for (const [href, texts] of expectations) {
    await tabTo(page, href)
    await page.waitForTimeout(550)
    const text = (await page.locator("[data-slot=hover-card-content]:visible").textContent()) ?? ""
    for (const expected of texts) expect(text).toContain(expected)
    expect(text).not.toContain("Goal tracking")
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
  }
  await page.close()
})

test("the sidebar row card opens on hover beside the row with its issues", async () => {
  const page = await harness.open("hover-cards")
  await page.hover("#row")
  await page.waitForTimeout(550)
  const preview = card(page, "HOME-2")
  expect(await preview.isVisible()).toBe(true)
  expect(await preview.textContent()).toContain("⌥1")
  expect(await preview.getByRole("link", { name: /AMA-22/ }).isVisible()).toBe(true)
  const row = await page.locator("#row").boundingBox()
  const box = await preview.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(row!.x + row!.width)
  await page.mouse.move(1200, 780)
  await page.waitForTimeout(450)
  expect(await preview.isVisible()).toBe(false)
  await page.close()
})

test("the message toolbar appears when focus enters the message and is one tab stop with arrow-key roving", async () => {
  const page = await harness.open("hover-cards")
  const toolbar = page.getByRole("toolbar", { name: "Message actions" })
  const opacity = () => toolbar.evaluate((element) => getComputedStyle(element.parentElement!).opacity)
  expect(await opacity()).toBe("0")
  await page.focus("#before-toolbar")
  await page.keyboard.press("Tab")
  expect(await active(page)).toBe("Reply")
  expect(await opacity()).toBe("1")
  await page.keyboard.press("ArrowRight")
  expect(await active(page)).toBe("Copy")
  await page.keyboard.press("ArrowRight")
  expect(await active(page)).toBe("More")
  await page.keyboard.press("ArrowRight")
  expect(await active(page)).toBe("Reply")
  await page.keyboard.press("ArrowLeft")
  expect(await active(page)).toBe("More")
  await page.keyboard.press("Enter")
  expect(await page.textContent("#log")).toBe("more")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => document.querySelector("#message")!.contains(document.activeElement))).toBe(false)
  expect(await opacity()).toBe("0")
  await page.close()
})

test("the message toolbar shows on hover and Copy confirms", async () => {
  const page = await harness.open("hover-cards")
  const toolbar = page.getByRole("toolbar", { name: "Message actions" })
  await page.hover("#message p")
  expect(await toolbar.evaluate((element) => getComputedStyle(element.parentElement!).opacity)).toBe("1")
  await page.getByRole("button", { name: "Copy" }).click()
  expect(await page.textContent("#log")).toBe("copy")
  expect(await page.getByRole("button", { name: "Copied" }).isVisible()).toBe(true)
  await page.close()
})
