import { afterAll, expect, test } from "bun:test"

const stored = new Map<string, string>()
const globals = {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  },
  window: { matchMedia: () => ({ matches: true, addEventListener: () => undefined }) },
}
const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, descriptor)
  }
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
