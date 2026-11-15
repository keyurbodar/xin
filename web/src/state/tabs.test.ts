import { expect, test } from "bun:test"

const stored = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  },
  window: { matchMedia: () => ({ matches: true, addEventListener: () => undefined }) },
})
const { closeThreadTabs, openThreadTab, openThreadTabs, reopenThreadTabs } = await import("./tabs.ts")

test("every close gets its own id, so undoing one close reopens only its tabs", () => {
  for (const id of [1, 2, 3]) openThreadTab("p", id)
  const first = closeThreadTabs("p", [2])
  const second = closeThreadTabs("p", [3])
  expect(second).not.toBe(first)
  reopenThreadTabs("p", first)
  expect(openThreadTabs("p")).toEqual([1, 2])
})
