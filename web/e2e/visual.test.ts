import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Frame, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"

const web = fileURLToPath(new URL("..", import.meta.url))
const renders = process.env.INGLE_RENDERS_DIR

let browser: Browser
let server: ViteDevServer
let base = ""

beforeAll(async () => {
  server = await createServer({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "error",
    server: { port: 0, host: "127.0.0.1" },
  })
  await server.listen()
  base = server.resolvedUrls?.local[0] ?? ""
  browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] })
  if (renders !== undefined) mkdirSync(renders, { recursive: true })
}, 60_000)

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function open(
  options: { fixture?: string; theme?: string; width?: number } = {},
): Promise<{ page: Page; frame: Frame }> {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1280, height: 900 } })
  await page.goto(
    `${base}e2e/fixtures/visual.html?fixture=${options.fixture ?? "dashboard"}&theme=${options.theme ?? "dark"}`,
  )
  const element = await page.waitForSelector('[data-block="visual"] iframe', { state: "attached", timeout: 30_000 })
  const frame = await element.contentFrame()
  if (frame === null) throw new Error("no frame")
  await page.waitForSelector('[data-visual-state="shown"]', { timeout: 30_000 })
  return { page, frame }
}

for (const theme of ["dark", "light"] as const) {
  test(`a visual renders its chart, stats and canvas in ${theme}, in theme colours`, async () => {
    const { page, frame } = await open({ theme })
    expect(await frame.locator(".v-chart svg rect[rx]").count()).toBeGreaterThan(3)
    expect(await frame.locator(".v-stat").count()).toBe(2)
    expect(await frame.locator(".v-canvas canvas").count()).toBe(1)
    const ink = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim(),
    )
    const text = await frame.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--text").trim(),
    )
    expect(text).toBe(ink)
    const height = await page
      .locator('[data-block="visual"] iframe')
      .evaluate((node) => node.getBoundingClientRect().height)
    const content = await frame.evaluate(() => document.documentElement.getBoundingClientRect().height)
    expect(Math.abs(height - content)).toBeLessThanOrEqual(1)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(300)
      if (renders !== undefined)
        await page.screenshot({ path: join(renders, `visual-${theme}-${width}.png`), fullPage: true })
    }
    await page.close()
  }, 60_000)
}

test("a control runs its Lua handler and the view renders again", async () => {
  const { page, frame } = await open()
  await frame.getByRole("tab", { name: "p99" }).click()
  await frame.getByText("Showing p99").waitFor()
  expect(await frame.getByRole("tab", { name: "p99" }).getAttribute("aria-selected")).toBe("true")
  await page.close()
}, 60_000)

test("the frame is sandboxed: opaque origin, no parent access, no network", async () => {
  const { page, frame } = await open()
  const probe = await frame.evaluate(async (url) => {
    const attempt = async (run: () => unknown): Promise<string> => {
      try {
        await run()
        return "allowed"
      } catch {
        return "blocked"
      }
    }
    return {
      origin: window.origin,
      parentDocument: await attempt(() => window.parent.document.body.innerHTML),
      topLocation: await attempt(() => window.top?.location.href),
      fetch: await attempt(() => fetch(url)),
      image: await new Promise<string>((resolve) => {
        const image = new Image()
        image.onload = () => resolve("allowed")
        image.onerror = () => resolve("blocked")
        image.src = `${url}favicon.ico`
      }),
      storage: await attempt(() => window.localStorage.length),
    }
  }, base)
  expect(probe).toEqual({
    origin: "null",
    parentDocument: "blocked",
    topLocation: "blocked",
    fetch: "blocked",
    image: "blocked",
    storage: "blocked",
  })
  expect(await page.locator('[data-block="visual"] iframe').getAttribute("sandbox")).toBe("allow-scripts")
  await page.close()
}, 60_000)

test("a streaming script draws as it arrives and never shows a half-written error", async () => {
  const { page, frame } = await open()
  const script = await page.evaluate(() => window.visualHarness.dashboard)
  await page.evaluate(() => window.visualHarness.set("", "streaming"))
  const cuts = [40, 160, 400, script.length - 30, script.length]
  for (const cut of cuts) {
    await page.evaluate(([text]) => window.visualHarness.set(text ?? "", "streaming"), [script.slice(0, cut)])
    await page.waitForTimeout(220)
    expect(await frame.locator(".v-error").isHidden()).toBe(true)
  }
  await page.locator('[data-visual-state="drawing"]').waitFor()
  await page.evaluate(([text]) => window.visualHarness.set(text ?? "", "done"), [script])
  await page.locator('[data-visual-state="shown"]').waitFor()
  expect(await frame.locator(".v-chart svg").count()).toBe(1)
  await page.close()
}, 60_000)

test("a failed call renders nothing, since the agent fixes and calls again", async () => {
  const { page } = await open()
  await page.evaluate(() => window.visualHarness.set("return ui.text { 'x', color = 'red' }", "error"))
  await page.locator('[data-block="visual"]').waitFor({ state: "detached" })
  await page.close()
}, 60_000)

test("the theme follows the app without reloading the script", async () => {
  const { page, frame } = await open({ theme: "dark" })
  const before = await frame.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--text").trim(),
  )
  await page.evaluate(() => window.visualHarness.theme("light"))
  await frame.waitForFunction(
    (previous) => getComputedStyle(document.documentElement).getPropertyValue("--text").trim() !== previous,
    before,
  )
  expect(await frame.evaluate(() => document.documentElement.dataset.scheme)).toBe("light")
  await page.close()
}, 60_000)

test("a dithered chart draws its bars as Bayer dots that grow denser toward the value", async () => {
  for (const theme of ["dark", "light"] as const) {
    const { page, frame } = await open({ fixture: "dither", theme })
    try {
      await frame.locator(".v-chart svg pattern").first().waitFor({ state: "attached" })
      const bars = await frame.evaluate(() => {
        const chart = document.querySelector(".v-chart svg")
        if (chart === null) return { pieces: 0, levels: [] as number[] }
        const fills = [...chart.querySelectorAll("rect[fill^='url(']")].map((rect) => rect.getAttribute("fill") ?? "")
        const dots = (fill: string): number => {
          const id = /url\(#(.+)\)/.exec(fill)?.[1] ?? ""
          return document.getElementById(id)?.childElementCount ?? 0
        }
        return { pieces: fills.length, levels: fills.slice(0, 8).map(dots) }
      })
      expect(bars.pieces).toBeGreaterThan(8)
      const first = bars.levels[0] ?? 0
      const last = bars.levels.at(-1) ?? 0
      expect(last).toBeGreaterThan(first)
      expect(await frame.locator(".v-error").isHidden()).toBe(true)
      await frame.getByRole("tab", { name: "Reactive Meets AI" }).click()
      await frame.locator(".v-chart svg rect[fill^='url(']").first().waitFor({ state: "attached" })
      if (renders !== undefined)
        await page.screenshot({ path: join(renders, `visual-dither-${theme}-1280.png`), fullPage: true })
    } finally {
      await page.close()
    }
  }
}, 90_000)

test("a 3D scene renders with WebGL inside the frame", async () => {
  const { page, frame } = await open({ fixture: "scene" })
  await frame.locator(".v-scene canvas").waitFor()
  await page.waitForTimeout(500)
  expect(await frame.locator(".v-error").isHidden()).toBe(true)
  if (renders !== undefined)
    await page.screenshot({ path: join(renders, "visual-scene-dark-1280.png"), fullPage: true })
  await page.close()
}, 60_000)

test("a hostile shader loop is bounded and the page keeps painting", async () => {
  const { page, frame } = await open()
  const shader = [
    "void mainImage(out vec4 c, in vec2 p) {",
    "  float t = 0.0;",
    "  for (int i = 0; i < 100000000; i++) { t += sin(float(i) * p.x); }",
    "  c = vec4(vec3(fract(t)), 1.0);",
    "}",
  ].join("\\n")
  await page.evaluate(
    (script) => window.visualHarness.set(script, "done"),
    `return ui.shader { height = 200, code = "${shader}" }`,
  )
  await frame.locator(".v-shader canvas").waitFor({ timeout: 30_000 })
  await page.waitForTimeout(500)
  const painted = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const start = performance.now()
        let frames = 0
        const tick = (): void => {
          frames += 1
          if (performance.now() - start > 1000) resolve(frames)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  expect(painted).toBeGreaterThan(5)
  expect(await frame.locator(".v-error").isHidden()).toBe(true)
  await page.close()
}, 60_000)

test("the host caps the frame height a frame asks for", async () => {
  const { page, frame } = await open()
  await page.locator('[data-block="visual"] iframe').evaluate((node) => {
    const seen: number[] = []
    Reflect.set(window, "seenHeights", seen)
    new MutationObserver(() => seen.push(node.getBoundingClientRect().height)).observe(node, { attributes: true })
  })
  await frame.evaluate(() => parent.postMessage({ kind: "size", height: 1e9 }, "*"))
  await page.waitForTimeout(300)
  const seen = await page.evaluate(() => Reflect.get(window, "seenHeights"))
  expect(Math.max(...seen)).toBe(10_000)
  await page.close()
}, 60_000)

test("full screen opens a second live frame and Esc closes it", async () => {
  const { page } = await open()
  await page.locator('[data-block="visual"]').hover()
  await page.getByRole("button", { name: "Full screen" }).click()
  await page.getByRole("dialog").waitFor()
  expect(await page.locator('[role="dialog"] iframe').count()).toBe(1)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.close()
}, 60_000)
