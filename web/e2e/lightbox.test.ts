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

const settled = (page: Page) => page.waitForTimeout(400)
const counter = (page: Page) => page.textContent("[data-testid=lightbox-counter]")
const zoom = (page: Page) => page.textContent("[data-testid=lightbox-zoom]")
const isOpen = (page: Page) => page.evaluate(() => document.querySelector("[data-testid=lightbox-stage]") !== null)
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement
    return element?.getAttribute("aria-label") ?? element?.tagName
  })
const shown = (page: Page) => page.getAttribute("[data-testid=lightbox-stage] img[data-active]", "alt")

async function openAt(index: number): Promise<Page> {
  const page = await harness.open("lightbox")
  await page.click(`#thumb-${index}`)
  await settled(page)
  return page
}

test("it opens as a named modal with focus on the selected thumbnail", async () => {
  const page = await openAt(1)
  const dialog = page.getByRole("dialog", { name: /diagram\.png/ })
  expect(await dialog.getAttribute("aria-modal")).toBe("true")
  expect(await counter(page)).toBe("2 / 3")
  expect(await focused(page)).toBe("diagram.png")
  expect(await page.getByRole("option", { name: "diagram.png" }).getAttribute("aria-selected")).toBe("true")
  await page.close()
})

test("ArrowLeft and ArrowRight move between images and stop at the ends", async () => {
  const page = await openAt(0)
  await page.getByRole("button", { name: "Close" }).focus()
  await page.keyboard.press("ArrowRight")
  expect(await counter(page)).toBe("2 / 3")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  expect(await counter(page)).toBe("3 / 3")
  expect(await shown(page)).toBe("phone.png")
  await page.keyboard.press("ArrowLeft")
  expect(await counter(page)).toBe("2 / 3")
  expect(await page.textContent("#index")).toBe("1")
  await page.close()
})

test("the arrow buttons navigate and disable at the ends", async () => {
  const page = await openAt(0)
  const previous = page.getByRole("button", { name: "Previous image" })
  const next = page.getByRole("button", { name: "Next image" })
  expect(await previous.isDisabled()).toBe(true)
  await next.click()
  await next.click()
  expect(await counter(page)).toBe("3 / 3")
  expect(await next.isDisabled()).toBe(true)
  await previous.click()
  expect(await counter(page)).toBe("2 / 3")
  await page.close()
})

test("the thumbnail strip is a listbox: arrows and presses select an image", async () => {
  const page = await openAt(0)
  await page.keyboard.press("ArrowRight")
  expect(await counter(page)).toBe("2 / 3")
  expect(await focused(page)).toBe("diagram.png")
  await page.keyboard.press("End")
  expect(await counter(page)).toBe("3 / 3")
  expect(await page.getByRole("option", { name: "phone.png" }).getAttribute("aria-selected")).toBe("true")
  await page.getByRole("option", { name: "screenshot.png" }).click()
  expect(await counter(page)).toBe("1 / 3")
  await page.close()
})

test("+ and - step the zoom, 100% and 200% jump, 0 and reset fit again", async () => {
  const page = await openAt(0)
  const fit = await zoom(page)
  expect(Number.parseInt(fit ?? "", 10)).toBeLessThan(100)
  await page.keyboard.press("+")
  expect(await zoom(page)).toBe("50%")
  await page.keyboard.press("+")
  await page.keyboard.press("+")
  expect(await zoom(page)).toBe("100%")
  await page.keyboard.press("-")
  expect(await zoom(page)).toBe("75%")
  await page.keyboard.press("0")
  expect(await zoom(page)).toBe(fit)
  await page.getByRole("button", { name: "200%" }).click()
  expect(await zoom(page)).toBe("200%")
  await page.getByRole("button", { name: "Fit to screen" }).click()
  expect(await zoom(page)).toBe(fit)
  await page.close()
})

test("a drag pans a zoomed image and switching images resets the zoom", async () => {
  const page = await openAt(0)
  await page.getByRole("button", { name: "200%" }).click()
  const image = page.locator("[data-testid=lightbox-stage] img[data-active]")
  const before = await image.boundingBox()
  await page.mouse.move(640, 400)
  await page.mouse.down()
  await page.mouse.move(740, 450, { steps: 5 })
  await page.mouse.up()
  const after = await image.boundingBox()
  expect(Math.round((after?.x ?? 0) - (before?.x ?? 0))).toBe(100)
  expect(Math.round((after?.y ?? 0) - (before?.y ?? 0))).toBe(50)
  await page.getByRole("button", { name: "Next image" }).click()
  expect(await zoom(page)).toBe("100%")
  await page.close()
})

test("Tab stays inside the lightbox", async () => {
  const page = await openAt(1)
  for (let step = 0; step < 14; step++) {
    await page.keyboard.press("Tab")
    expect(await page.evaluate(() => document.querySelector("[data-slot=dialog-content]")?.contains(document.activeElement))).toBe(true)
  }
  await page.close()
})

test("Escape closes it and focus returns to the attachment that opened it", async () => {
  const page = await openAt(2)
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("Escape")
  await settled(page)
  expect(await isOpen(page)).toBe(false)
  expect(await focused(page)).toBe("Open phone.png")
  await page.close()
})

test("the close button closes it and returns focus too", async () => {
  const page = await openAt(0)
  await page.getByRole("button", { name: "Close" }).click()
  await settled(page)
  expect(await isOpen(page)).toBe(false)
  expect(await focused(page)).toBe("Open screenshot.png")
  await page.close()
})
