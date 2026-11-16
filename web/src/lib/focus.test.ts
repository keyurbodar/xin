import { expect, test } from "bun:test"
import { createFocusReturn, nextFocus } from "./focus.ts"

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

test("leaving an inline editor by key or button focuses the trigger that mounts in its place; a blur moves nothing", () => {
  const queued: (() => void)[] = []
  const focused: string[] = []
  const element = (name: string) => ({ focus: () => focused.push(name) })
  const focus = createFocusReturn((run) => queued.push(run))
  focus.trigger(element("first trigger"))
  focus.exit("key")
  focus.trigger(element("remounted trigger"))
  for (const run of queued.splice(0)) run()
  expect(focused).toEqual(["remounted trigger"])
  focus.exit("button")
  for (const run of queued.splice(0)) run()
  expect(focused).toEqual(["remounted trigger", "remounted trigger"])
  focus.exit("blur")
  expect(queued).toHaveLength(0)
})
