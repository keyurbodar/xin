import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { chromium, type Browser } from "playwright"

const css = readFileSync(new URL("../src/styles/ingle-motion.css", import.meta.url), "utf8")
const STATES = ["working", "needs", "waiting"] as const

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

async function signalAnimations(reduce: "os" | "setting" | "none"): Promise<Record<string, string[]>> {
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: reduce === "os" ? "reduce" : "no-preference" })
  const dots = "<i></i>".repeat(9)
  await page.setContent(
    `<html${reduce === "setting" ? ' data-motion="reduce"' : ""}><head><style>${css}</style></head><body>${STATES.map(
      (state) => `<span class="sig" data-state="${state}">${dots}</span>`,
    ).join("")}</body></html>`,
  )
  const names = await page.evaluate((states) => {
    const out: Record<string, string[]> = {}
    for (const state of states) {
      const signal = document.querySelector(`.sig[data-state="${state}"]`)
      out[state] = [...(signal?.querySelectorAll("i") ?? [])].map((dot) => getComputedStyle(dot).animationName)
    }
    return out
  }, STATES)
  await page.close()
  return names
}

test("Signal loops run without reduced motion", async () => {
  const names = await signalAnimations("none")
  for (const state of STATES) expect(names[state]?.some((name) => name !== "none")).toBe(true)
})

test("the OS reduced-motion setting stills every Signal dot", async () => {
  const names = await signalAnimations("os")
  for (const state of STATES) expect(names[state]?.every((name) => name === "none")).toBe(true)
})

test("the Reduce motion setting stills every Signal dot", async () => {
  const names = await signalAnimations("setting")
  for (const state of STATES) expect(names[state]?.every((name) => name === "none")).toBe(true)
})

const indicators = readFileSync(new URL("../src/styles/indicators.css", import.meta.url), "utf8")
const LOOPS = [".im-spinner", ".im-boot-shape", ".im-boot-orbit", ".im-boot-pen"] as const
const BOOT = `<svg class="im-spinner" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 0 1 6 6" /></svg>
<div class="im-boot"><svg viewBox="0 0 96 96"><path class="im-boot-guide" d="M4 48h88M48 4v88" />
<path class="im-boot-shape" pathLength="1" d="M24 24h48v48H24Z" />
<path class="im-boot-shape" pathLength="1" d="M48 24a24 24 0 1 1 0 48a24 24 0 1 1 0-48" />
<path class="im-boot-shape" pathLength="1" d="M48 24 72 72H24Z" />
<path class="im-boot-pen" d="M-3 0h6M0-3v6" />
<g class="im-boot-orbit"><path class="im-boot-pen" d="M45 24h6M48 21v6" /></g></svg></div>`

async function indicatorAnimations(reduce: "os" | "setting" | "none"): Promise<Record<string, string[]>> {
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: reduce === "os" ? "reduce" : "no-preference" })
  await page.setContent(
    `<html${reduce === "setting" ? ' data-motion="reduce"' : ""}><head><style>${css}</style><style>${indicators}</style></head><body>${BOOT}</body></html>`,
  )
  const names = await page.evaluate((loops) => {
    const out: Record<string, string[]> = {}
    for (const loop of loops) out[loop] = [...document.querySelectorAll(loop)].map((element) => getComputedStyle(element).animationName)
    return out
  }, LOOPS)
  await page.close()
  return names
}

test("spinner and boot-trace loops run without reduced motion", async () => {
  const names = await indicatorAnimations("none")
  for (const loop of LOOPS) expect(names[loop]?.every((name) => name !== "none")).toBe(true)
})

test("the OS reduced-motion setting stills the spinner and the boot trace", async () => {
  const names = await indicatorAnimations("os")
  for (const loop of LOOPS) expect(names[loop]?.every((name) => name === "none")).toBe(true)
})

test("the Reduce motion setting stills the spinner and the boot trace", async () => {
  const names = await indicatorAnimations("setting")
  for (const loop of LOOPS) expect(names[loop]?.every((name) => name === "none")).toBe(true)
})

async function hoveredSwipe(reduce: "os" | "setting" | "none"): Promise<string> {
  const page = await browser.newPage()
  await page.emulateMedia({ reducedMotion: reduce === "os" ? "reduce" : "no-preference" })
  await page.setContent(
    `<html${reduce === "setting" ? ' data-motion="reduce"' : ""}><head><style>${css}</style></head><body><div class="im-toast-stack" style="position:fixed;bottom:20px;left:20px;width:200px;height:120px"><div class="im-toast" style="--i:0">a</div><div class="im-toast" id="swiping" data-swiping style="--i:1;--offset:40px;--swipe-x:50px">b</div></div></body></html>`,
  )
  await page.hover(".im-toast-stack")
  const transform = await page.evaluate(() => getComputedStyle(document.getElementById("swiping") as Element).transform)
  await page.close()
  return transform
}

test("a swiping toast follows the pointer over the hover fan-out, with or without reduced motion", async () => {
  for (const reduce of ["none", "os", "setting"] as const) {
    expect(await hoveredSwipe(reduce)).toBe("matrix(1, 0, 0, 1, 50, 0)")
  }
})
