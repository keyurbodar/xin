import { expect, test } from "bun:test"
import { wrapFocus } from "./focus.ts"

const items = ["not-now", "turn-on"] as const

test("Tab from the last control or from outside the dialog wraps to the first", () => {
  expect(wrapFocus(items, "turn-on", false)).toBe("not-now")
  expect(wrapFocus(items, null, false)).toBe("not-now")
})

test("Shift+Tab from the first control or from outside wraps to the last", () => {
  expect(wrapFocus(items, "not-now", true)).toBe("turn-on")
  expect(wrapFocus<string>(items, "checklist", true)).toBe("turn-on")
})

test("Tab between controls inside the dialog is left to the browser", () => {
  expect(wrapFocus(items, "not-now", false)).toBeUndefined()
  expect(wrapFocus(items, "turn-on", true)).toBeUndefined()
  expect(wrapFocus([], null, false)).toBeUndefined()
})
