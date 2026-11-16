import { beforeAll, expect, test } from "bun:test"
import { stubGlobals } from "../../test/globals.ts"

const stored = new Map<string, string>()
stubGlobals({
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  },
  window: { location: { hash: "" }, matchMedia: () => ({ matches: true, addEventListener: () => undefined }) },
})
let tabs: typeof import("./tabs.ts")
beforeAll(async () => {
  tabs = await import("./tabs.ts")
})

test("every close gets its own id, so undoing one close reopens only its tabs", () => {
  for (const id of [1, 2, 3]) tabs.openThreadTab("p", id)
  const first = tabs.closeThreadTabs("p", [2])
  const second = tabs.closeThreadTabs("p", [3])
  expect(second).not.toBe(first)
  tabs.reopenThreadTabs("p", first)
  expect(tabs.openThreadTabs("p")).toEqual([1, 2])
})
