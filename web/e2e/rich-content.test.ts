import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
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
  browser = await chromium.launch()
  if (renders !== undefined) mkdirSync(renders, { recursive: true })
}, 60_000)

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function open(fixture: string, options: { theme?: string; width?: number } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1280, height: 900 } })
  await page.goto(`${base}e2e/fixtures/rich-content.html?fixture=${fixture}&theme=${options.theme ?? "dark"}`)
  await page.waitForSelector("main")
  return page
}

for (const theme of ["dark", "light"] as const) {
  test(`mermaid renders an svg in ${theme}`, async () => {
    const page = await open("mermaid", { theme })
    const svg = page.locator('[data-block="mermaid"] .mermaid-diagram svg')
    await svg.waitFor({ timeout: 30_000 })
    const fill = await page.evaluate(() => {
      const node = document.querySelector('.mermaid-diagram svg .node rect, .mermaid-diagram svg .node polygon')
      return node === null ? "" : getComputedStyle(node).fill
    })
    const card = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--color-card").trim())
    expect(fill).not.toBe("")
    expect(card).toBe(theme === "dark" ? "#1b1b1c" : "#ffffff")
    await page.close()
  }, 60_000)
}

test("mermaid re-renders when the theme changes", async () => {
  const page = await open("mermaid", { theme: "dark" })
  await page.locator('[data-block="mermaid"] .mermaid-diagram svg').waitFor({ timeout: 30_000 })
  const before = await page.locator('[data-block="mermaid"] .mermaid-diagram svg').innerHTML()
  await page.evaluate(() => window.harness.theme("light"))
  await page.waitForFunction(
    (previous) => document.querySelector('[data-block="mermaid"] .mermaid-diagram svg')?.innerHTML !== previous,
    before,
    { timeout: 10_000 },
  )
  await page.close()
}, 60_000)

test("a broken mermaid diagram shows its source and a short error, never the bomb", async () => {
  const page = await open("broken")
  const error = page.locator('[data-block="mermaid-error"]')
  await error.waitFor({ timeout: 30_000 })
  expect(await error.locator(".code-block").innerText()).toContain("a --> --> b((")
  expect(await error.locator('[role="status"]').innerText()).toContain("Diagram error")
  const strays = await page.evaluate(() => [...document.body.children].filter((node) => node.id !== "root" && node.tagName !== "SCRIPT").length)
  expect(strays).toBe(0)
  expect(await page.locator("svg[aria-roledescription=error]").count()).toBe(0)
  await page.close()
}, 60_000)

test("a long table collapses to ten rows and Show all reveals every row", async () => {
  const page = await open("table")
  const body = page.locator('[data-block="table"] tbody tr')
  expect(await body.count()).toBe(10)
  await page.getByRole("button", { name: "Show all 20 rows" }).click()
  expect(await body.count()).toBe(20)
  const align = await page.locator('[data-block="table"] tbody tr >> nth=0 >> td >> nth=1').evaluate((cell) => getComputedStyle(cell).textAlign)
  expect(align).toBe("right")
  expect(await page.locator('[data-block="table"] tbody tr >> nth=0 >> td >> nth=2').innerText()).toBe("ok | fine")
  await page.close()
})

test("a long code block collapses and expands", async () => {
  const page = await open("code")
  const region = page.locator('[data-block="code"] .block-expand')
  const collapsed = await region.evaluate((element) => element.getBoundingClientRect().height)
  expect(collapsed).toBeLessThanOrEqual(421)
  const toggle = page.getByRole("button", { name: /Expand/ })
  expect(await toggle.innerText()).toContain("60 lines")
  await toggle.click()
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-block="code"] .block-expand')
    return element !== null && element.getBoundingClientRect().height > 1000
  })
  expect(await page.getByRole("button", { name: /Collapse/ }).getAttribute("aria-expanded")).toBe("true")
  await page.close()
})

test("full screen opens, Esc closes it and focus returns to the opener", async () => {
  const page = await open("code")
  const opener = page.getByRole("button", { name: "Open code full screen" })
  await opener.click()
  const dialog = page.getByRole("dialog")
  await dialog.waitFor()
  expect(await dialog.locator(".sh__line").count()).toBe(60)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Open code full screen")
  await page.close()
})

test("streaming text with an unclosed fence renders and then finalises", async () => {
  const page = await open("stream")
  await page.evaluate(() => window.harness.set("Plan:\n\n```mermaid\nflowchart LR\n  a --> b", true))
  const streamingCode = page.locator('[data-block="code"]')
  await streamingCode.waitFor()
  expect(await streamingCode.innerText()).toContain("a --> b")
  expect(await page.locator('[data-block="mermaid"]').count()).toBe(0)
  await page.evaluate(() => window.harness.set("Plan:\n\n```mermaid\nflowchart LR\n  a --> b\n  b --> c", true))
  await page.waitForFunction(() => document.querySelector('[data-block="code"] code')?.textContent?.includes("b --> c") === true)
  await page.evaluate(() => window.harness.set("Plan:\n\n```mermaid\nflowchart LR\n  a --> b\n  b --> c\n```\nDone.", false))
  await page.locator('[data-block="mermaid"] .mermaid-diagram svg').waitFor({ timeout: 30_000 })
  expect(await page.locator("main p").last().innerText()).toBe("Done.")
  await page.close()
}, 60_000)

test("a fence registered at run time replaces the code block and unregisters cleanly", async () => {
  const page = await open("stream")
  await page.evaluate(() => window.harness.set("```chart\n1,2,3\n```", false))
  await page.locator('[data-block="code"]').waitFor()
  await page.evaluate(() => {
    const off = window.harness.register("chart")
    Object.assign(window, { off })
  })
  expect(await page.getByTestId("custom-fence").innerText()).toContain("custom chart: 1,2,3")
  await page.evaluate(() => (window as unknown as { off: () => void }).off())
  await page.locator('[data-block="code"]').waitFor()
  await page.close()
})

test.skipIf(renders === undefined)("screenshots in dark and light at desktop and narrow widths", async () => {
  const dir = renders ?? ""
  for (const theme of ["dark", "light"] as const) {
    for (const width of [1280, 390]) {
      const page = await open("all", { theme, width })
      await page.locator('[data-block="mermaid"] .mermaid-diagram svg').waitFor({ timeout: 30_000 })
      await page.locator('[data-block="mermaid-error"]').waitFor({ timeout: 30_000 })
      await page.screenshot({ path: join(dir, `core-${theme}-${width}.png`), fullPage: true })
      await page.close()
    }
  }
  const page = await open("all", { theme: "dark" })
  await page.locator('[data-block="mermaid"] .mermaid-diagram svg').waitFor({ timeout: 30_000 })
  await page.getByRole("button", { name: "Open diagram full screen" }).click()
  await page.getByRole("dialog").waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(dir, "core-dark-1280-fullscreen.png") })
  await page.close()
}, 120_000)

test("a hostile diagram renders without any request leaving the harness origin", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const origin = new URL(base).origin
  const outside: string[] = []
  await page.route("**/*", (route) => {
    const url = route.request().url()
    if (url.startsWith("data:") || new URL(url).origin === origin) return route.continue()
    outside.push(url)
    return route.abort()
  })
  await page.goto(`${base}e2e/fixtures/rich-content.html?fixture=hostile&theme=dark`)
  const diagram = page.locator('[data-block="mermaid"] .mermaid-diagram svg')
  await diagram.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(500)
  expect(outside).toEqual([])
  const leftovers = await diagram.evaluate((svg) => ({
    tags: svg.querySelectorAll("img, image, foreignObject, a, script").length,
    links: [...svg.querySelectorAll("*")].flatMap((node) =>
      [...node.attributes].filter((attribute) => /href|src/i.test(attribute.name) && !attribute.value.startsWith("#")).map((attribute) => attribute.value),
    ),
    text: svg.textContent ?? "",
  }))
  expect(leftovers.tags).toBe(0)
  expect(leftovers.links).toEqual([])
  expect(leftovers.text).toContain("safe")
  await page.close()
}, 60_000)

test("a renderer that throws falls back to its source and keeps the message", async () => {
  const page = await open("stream")
  await page.evaluate(() => window.harness.register("boom", true))
  await page.evaluate(() => window.harness.set("Before the block.\n\n```boom\nkaboom source\n```\n\nAfter the block.", false))
  await page.getByText("After the block.").waitFor()
  expect(await page.getByText("Before the block.").count()).toBe(1)
  expect(await page.locator('[data-block="code"]').innerText()).toContain("kaboom source")
  expect(await page.getByTestId("custom-fence").count()).toBe(0)
  await page.close()
})

test("text streaming after finished blocks never re-highlights the code or redraws the diagram", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => {
    const replaceAll = String.prototype.replaceAll
    Object.assign(window, { highlights: 0 })
    Object.defineProperty(String.prototype, "replaceAll", {
      configurable: true,
      writable: true,
      value(this: string, search: string | RegExp, replacement: string) {
        if (search === '\n<span class="sh__line') Object.assign(window, { highlights: (window as unknown as { highlights: number }).highlights + 1 })
        return Reflect.apply(replaceAll, this, [search, replacement])
      },
    })
  })
  await page.goto(`${base}e2e/fixtures/rich-content.html?fixture=stream&theme=dark`)
  const head = "```ts\nconst a = 1\n```\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\nNow"
  await page.evaluate((text) => window.harness.set(text, true), head)
  const svg = page.locator('[data-block="mermaid"] .mermaid-diagram svg')
  await svg.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    Object.assign(document.querySelector('[data-block="mermaid"] .mermaid-diagram svg') ?? {}, { kept: true })
    Object.assign(document.querySelector('[data-block="code"] code') ?? {}, { kept: true })
  })
  const before = await page.evaluate(() => (window as unknown as { highlights: number }).highlights)
  for (const word of [" the", " reply", " keeps", " streaming", " for", " a", " while"]) {
    await page.evaluate((text) => window.harness.set(text, true), head + word)
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => ({
    highlights: (window as unknown as { highlights: number }).highlights,
    svg: (document.querySelector('[data-block="mermaid"] .mermaid-diagram svg') as unknown as { kept?: boolean } | null)?.kept,
    code: (document.querySelector('[data-block="code"] code') as unknown as { kept?: boolean } | null)?.kept,
  }))
  expect(before).toBeGreaterThan(0)
  expect(after).toEqual({ highlights: before, svg: true, code: true })
  await page.close()
}, 60_000)

test("a link with a non-http scheme renders as text", async () => {
  const page = await open("stream")
  await page.evaluate(() => window.harness.set("Do not [click me](javascript:alert(1)) or [this](data:text/html,x).", false))
  await page.getByText("Do not").waitFor()
  expect(await page.locator("main a").count()).toBe(0)
  expect(await page.locator("main p").innerText()).toContain("[click me](javascript:alert(1))")
  await page.close()
})

test("a streaming mermaid fence stays source and never draws", async () => {
  const page = await open("stream")
  await page.evaluate(() => window.harness.set("```mermaid\nflowchart LR\n  a --> b\n", true))
  await page.locator('[data-block="code"]').waitFor()
  await page.waitForTimeout(1_000)
  expect(await page.locator(".mermaid-diagram").count()).toBe(0)
  expect(await page.locator('[data-block="code"]').innerText()).toContain("a --> b")
  await page.close()
})

for (const reduce of ["none", "os", "setting"] as const) {
  test(`the expand transition ${reduce === "none" ? "runs" : `is off under the ${reduce} reduced-motion setting`}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.emulateMedia({ reducedMotion: reduce === "os" ? "reduce" : "no-preference" })
    await page.goto(`${base}e2e/fixtures/rich-content.html?fixture=code&theme=dark`)
    await page.getByRole("button", { name: /Expand/ }).waitFor()
    if (reduce === "setting") await page.evaluate(() => document.documentElement.setAttribute("data-motion", "reduce"))
    const transition = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-block="code"] button[aria-expanded]')?.click()
      const region = document.querySelector('[data-block="code"] .block-expand')
      return region === null ? "" : `${getComputedStyle(region).transitionProperty} ${getComputedStyle(region).transitionDuration}`
    })
    expect(transition).toBe(reduce === "none" ? "max-height 0.2s" : "none 0s")
    await page.close()
  })
}

test("a registered tool block keeps its DOM node while its args change", async () => {
  const page = await open("stream")
  await page.evaluate(() => {
    window.harness.registerTool()
  })
  const block = page.getByTestId("tool-probe")
  await block.waitFor()
  await block.evaluate((node) => Object.assign(node, { kept: true }))
  for (const step of [1, 2, 3]) await page.evaluate((next) => window.harness.step(next), step)
  expect(await block.innerText()).toBe("step 3")
  expect(await block.evaluate((node) => (node as unknown as { kept?: boolean }).kept)).toBe(true)
  await page.close()
})
