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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
const IMAGE = { status: 200, contentType: "image/png", body: PNG, headers: { "access-control-allow-origin": "*" } }

async function gallery(options: { width?: number; origin?: string; requests?: string[] } = {}): Promise<Page> {
  const origin = options.origin ?? ""
  const page = await harness.open("lightbox", {
    width: options.width ?? 1280,
    search: `?count=12${origin === "" ? "" : `&origin=${encodeURIComponent(origin)}`}`,
    before: (page) =>
      page.route(/\/e2e\/img\/\d+\.png$/, (route) => {
        options.requests?.push(route.request().url())
        return route.fulfill(IMAGE)
      }),
  })
  await page.click("#thumb-0")
  await settled(page)
  return page
}

test("at 390px a long gallery keeps every control inside the viewport", async () => {
  const page = await gallery({ width: 390 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll("[data-slot=dialog-content] :is(button, a, ui-listbox)")].flatMap((element) => {
      const box = element.getBoundingClientRect()
      return box.left < 0 || box.right > innerWidth ? [element.getAttribute("aria-label") ?? element.tagName] : []
    }),
  )
  expect(outside).toEqual([])
  await page.close()
})

test("only the current image and its neighbour load on the stage, and thumbnails load lazily", async () => {
  const requests: string[] = []
  const page = await gallery({ width: 390, requests })
  expect(await page.locator("[data-testid=lightbox-stage] img").count()).toBe(2)
  expect(await page.locator("ui-listbox-item img[loading=lazy]").count()).toBe(12)
  expect(new Set(requests).size).toBeLessThan(12)
  await page.getByRole("button", { name: "Next image" }).click()
  expect(await page.locator("[data-testid=lightbox-stage] img").count()).toBe(3)
  await page.close()
})

test("the selected thumbnail scrolls into view when the image changes", async () => {
  const page = await gallery({ width: 390 })
  const next = page.getByRole("button", { name: "Next image" })
  for (let step = 0; step < 11; step++) await next.click()
  expect(await counter(page)).toBe("12 / 12")
  const strip = await page.locator("ui-listbox").boundingBox()
  const last = await page.getByRole("option", { name: "image-11.png" }).boundingBox()
  expect(last!.x + last!.width).toBeLessThanOrEqual(strip!.x + strip!.width + 1)
  expect(last!.x).toBeGreaterThanOrEqual(strip!.x - 1)
  await page.close()
})

test("a refused clipboard shows a status instead of failing silently", async () => {
  const page = await openAt(0)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.evaluate(() => {
    const refuse = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
    Object.defineProperty(navigator, "clipboard", { value: { write: refuse, writeText: refuse } })
  })
  await page.getByRole("button", { name: "Copy image" }).click()
  await settled(page)
  expect(await page.getByText("The browser blocked the clipboard.").getAttribute("role")).toBe("status")
  expect(errors).toEqual([])
  await page.close()
})

test("the blocked-clipboard status clears on its timer, on the next image and on reopening", async () => {
  const page = await openAt(0)
  await page.evaluate(() => {
    const refuse = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
    Object.defineProperty(navigator, "clipboard", { value: { write: refuse, writeText: refuse } })
  })
  const blocked = page.getByText("The browser blocked the clipboard.")
  const copy = page.getByRole("button", { name: "Copy image" })
  await copy.click()
  await blocked.waitFor()
  await page.getByRole("button", { name: "Next image" }).click()
  expect(await blocked.count()).toBe(0)
  await copy.click()
  await blocked.waitFor()
  await page.getByRole("button", { name: "Close" }).click()
  await settled(page)
  await page.click("#thumb-2")
  await settled(page)
  expect(await blocked.count()).toBe(0)
  await copy.click()
  await blocked.waitFor()
  await page.waitForTimeout(4200)
  expect(await blocked.count()).toBe(0)
  await page.close()
})

for (const outcome of ["refused", "successful"] as const) {
  test(`a ${outcome} copy that settles after the image changes shows nothing on the next image`, async () => {
    const page = await openAt(0)
    await page.evaluate((refuse) => {
      const settle = () =>
        new Promise<void>((resolve, reject) =>
          setTimeout(() => (refuse ? reject(new DOMException("denied", "NotAllowedError")) : resolve()), 600),
        )
      Object.defineProperty(navigator, "clipboard", { value: { write: settle, writeText: settle } })
    }, outcome === "refused")
    await page.getByRole("button", { name: "Copy image" }).click()
    await page.waitForTimeout(100)
    await page.getByRole("button", { name: "Next image" }).click()
    await page.waitForTimeout(1300)
    expect(await counter(page)).toBe("2 / 3")
    expect(await page.getByText("The browser blocked the clipboard.").count()).toBe(0)
    expect(await page.getByRole("button", { name: "Copied" }).count()).toBe(0)
    await page.close()
  })
}

test("a cross-origin image downloads as a file without navigating the app", async () => {
  const page = await gallery({ origin: "https://images.example" })
  const before = page.url()
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download" }).click()])
  expect(download.suggestedFilename()).toBe("image-0.png")
  expect(page.url()).toBe(before)
  await page.close()
})

test("a cross-origin download that cannot be fetched opens in a new tab", async () => {
  const page = await gallery({ origin: "https://images.example" })
  const before = page.url()
  await page.unroute(/\/e2e\/img\/\d+\.png$/)
  await page.route(/\/e2e\/img\/\d+\.png$/, (route) => route.abort())
  await page.context().route(/\/e2e\/img\/\d+\.png$/, (route) => route.fulfill(IMAGE))
  const [tab] = await Promise.all([page.context().waitForEvent("page"), page.getByRole("link", { name: "Download" }).click()])
  expect(tab.url()).toContain("images.example/e2e/img/0.png")
  expect(page.url()).toBe(before)
  await page.close()
})

test("the counter is a polite live region", async () => {
  const page = await openAt(0)
  expect(await page.getAttribute("[data-testid=lightbox-counter]", "aria-live")).toBe("polite")
  await page.close()
})

test("a keyboard switch is instant and a pointer switch crossfades", async () => {
  const page = await openAt(0)
  const duration = () =>
    page.locator("[data-testid=lightbox-stage] img[data-active]").evaluate((image) => getComputedStyle(image).transitionDuration)
  await page.getByRole("button", { name: "Next image" }).click()
  expect(await duration()).toBe("0.15s")
  await page.keyboard.press("ArrowRight")
  expect(await duration()).toBe("0s")
  await page.close()
})

for (const [label, reduce] of [
  ["the OS setting", (page: Page) => page.emulateMedia({ reducedMotion: "reduce" })],
  ["the Appearance setting", (page: Page) => page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduce"))],
] as const) {
  test(`under reduced motion from ${label} a keyboard switch is still instant`, async () => {
    const page = await openAt(0)
    await reduce(page)
    await page.getByRole("button", { name: "Close" }).focus()
    await page.keyboard.press("ArrowRight")
    expect(
      await page.locator("[data-testid=lightbox-stage] img[data-active]").evaluate((image) => getComputedStyle(image).transitionDuration),
    ).toBe("0s")
    await page.close()
  })
}

test("a pan stops at the image's edge", async () => {
  const page = await openAt(1)
  await page.getByRole("button", { name: "200%" }).click()
  const stage = await page.locator("[data-testid=lightbox-stage]").boundingBox()
  await page.mouse.move(640, 400)
  await page.mouse.down()
  await page.mouse.move(1140, 700, { steps: 8 })
  await page.mouse.up()
  const image = await page.locator("[data-testid=lightbox-stage] img[data-active]").boundingBox()
  expect(Math.round(image!.x)).toBe(Math.round(stage!.x))
  expect(Math.round(image!.y)).toBe(Math.round(stage!.y))
  await page.close()
})
