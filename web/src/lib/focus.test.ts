import { expect, test } from "bun:test"
import { nextFocus, returnTarget } from "./focus.ts"

test("Tab wraps from the last stop to the first, and Shift+Tab from the first to the last", () => {
  expect(nextFocus(3, 0, false)).toBe(1)
  expect(nextFocus(3, 2, false)).toBe(0)
  expect(nextFocus(3, 0, true)).toBe(2)
  expect(nextFocus(3, 1, true)).toBe(0)
})

test("focus outside the trap enters at the near end, and an empty trap moves nothing", () => {
  expect(nextFocus(3, -1, false)).toBe(0)
  expect(nextFocus(3, -1, true)).toBe(2)
  expect(nextFocus(0, -1, false)).toBeUndefined()
  expect(nextFocus(1, 0, false)).toBe(0)
})

test("a closing dialog returns focus to where it last escaped to, else to its opener, skipping detached elements", () => {
  const trigger = { name: "trigger", isConnected: true }
  const item = { name: "menu item", isConnected: false }
  expect(returnTarget([trigger, item])).toBe(trigger)
  expect(returnTarget([undefined, item, trigger])).toBe(trigger)
  expect(returnTarget([undefined, null])).toBeUndefined()
})
