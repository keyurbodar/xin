import { expect, test } from "bun:test"
import { pageOf } from "./pages.ts"

const items = Array.from({ length: 45 }, (_, index) => index + 1)

test("a page holds twenty items, and the last page holds the rest", () => {
  expect(pageOf(items, 1)).toEqual(items.slice(0, 20))
  expect(pageOf(items, 3)).toEqual([41, 42, 43, 44, 45])
})

test("a page past either end clamps, and an empty list is one empty page", () => {
  expect(pageOf(items, 9)).toEqual([41, 42, 43, 44, 45])
  expect(pageOf(items, 0)).toEqual(items.slice(0, 20))
  expect(pageOf([], 1)).toEqual([])
})
