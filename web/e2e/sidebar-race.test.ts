import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { startHarness, type Harness } from "./harness.ts"

setDefaultTimeout(180_000)

let harness: Harness

beforeAll(async () => {
  harness = await startHarness()
})

afterAll(async () => {
  await harness.close()
})

const PROJECTS = ["Alpha", "Beta", "Gamma"]
const THREADS: Readonly<Record<string, readonly string[]>> = {
  Alpha: ["Alpha first", "Alpha second"],
  Beta: ["Beta first", "Beta second"],
  Gamma: ["Gamma first"],
}
const LOADS = 24

/** Each route and the project whose threads the sidebar must list there. */
const ROUTES: readonly (readonly [string, string])[] = [
  ["/", "Alpha"],
  ["/c/bosun", "Beta"],
  ["/settings/general", "Alpha"],
  ["/p/gamma", "Gamma"],
]

for (const [to, project] of ROUTES) {
  test(`#${to} lists every project and ${project}'s threads on ${LOADS} loads, whichever of the snapshot and the route lands first`, async () => {
    for (let load = 0; load < LOADS; load++) {
      const snap = Math.round(Math.random() * 150)
      const route = Math.round(Math.random() * 150)
      const page = await harness.open("sidebar-race", { search: `?snap=${snap}&route=${route}&to=${encodeURIComponent(to)}` })
      try {
        const seen = await page.evaluate(async (names) => {
          await (window as unknown as { settled: Promise<void> }).settled
          const aside = document.querySelector("aside")
          const buttons = [...(aside?.querySelectorAll("button") ?? [])]
          const title = (button: Element): string => button.querySelector(".truncate")?.textContent ?? ""
          return {
            projects: buttons.filter((button) => names.includes(title(button))).map((button) => `${title(button)}:${getComputedStyle(button).opacity}`),
            threads: buttons.map(title).filter((text) => text.includes(" first") || text.includes(" second")),
            added: (window as unknown as { added: string[] }).added,
            claimed: (window as unknown as { claimed: string[] }).claimed,
          }
        }, PROJECTS)
        const label = `load ${load} (snap ${snap} ms, route ${route} ms)`
        expect({ label, projects: seen.projects }).toEqual({ label, projects: PROJECTS.map((name) => `${name}:1`) })
        expect({ label, threads: seen.threads, claimed: seen.claimed }).toEqual({ label, threads: [...(THREADS[project] ?? [])], claimed: [] })
        expect({ label, added: seen.added.filter((title) => !(THREADS[project] ?? []).includes(title)) }).toEqual({ label, added: [] })
      } finally {
        await page.close()
      }
    }
  })
}
