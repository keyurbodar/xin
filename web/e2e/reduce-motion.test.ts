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
