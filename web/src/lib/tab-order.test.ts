import { expect, test } from "bun:test"
import { closeTabs, forgetTabs, moveTab, nearestKept, openTab, openTabs, reopenTabs, type TabOrder } from "./tab-order.ts"

const tabs = (...order: number[]): TabOrder => ({ order, closed: [] })

test("close T3, close T4, undo T3, undo T4 gives the original order", () => {
  const closed = closeTabs(closeTabs(tabs(1, 2, 3, 4), [3]), [4])
  expect(openTabs(closed)).toEqual([1, 2])
  const three = reopenTabs(closed, [3])
  expect(openTabs(three)).toEqual([1, 2, 3])
  expect(openTabs(reopenTabs(three, [4]))).toEqual([1, 2, 3, 4])
})

test("the same closes undone in reverse order also give the original order", () => {
  const closed = closeTabs(closeTabs(tabs(1, 2, 3, 4), [3]), [4])
  const four = reopenTabs(closed, [4])
  expect(openTabs(four)).toEqual([1, 2, 4])
  expect(openTabs(reopenTabs(four, [3]))).toEqual([1, 2, 3, 4])
})

test("tabs closed together come back together in their slots", () => {
  const closed = closeTabs(tabs(1, 2, 3, 4), [1, 3])
  expect(openTabs(closed)).toEqual([2, 4])
  expect(openTabs(reopenTabs(closed, [1, 3]))).toEqual([1, 2, 3, 4])
})

test("a tab already open again keeps its place and is not duplicated", () => {
  const closed = closeTabs(tabs(1, 2, 3), [2])
  const reopened = openTab(closed, 2)
  expect(reopened.order).toEqual([1, 2, 3])
  expect(openTabs(reopenTabs(reopened, [2]))).toEqual([1, 2, 3])
  expect(openTabs(forgetTabs(reopened, [2]))).toEqual([1, 2, 3])
})

test("an ended undo window drops the placeholder, and a new tab goes at the end", () => {
  const forgotten = forgetTabs(closeTabs(tabs(1, 2, 3), [2]), [2])
  expect(forgotten).toEqual({ order: [1, 3], closed: [] })
  expect(openTab(forgotten, 2).order).toEqual([1, 3, 2])
})

test("a drag counts only open tabs, and placeholders stay beside their neighbours", () => {
  const closed = closeTabs(tabs(1, 2, 3, 4), [2])
  const moved = moveTab(closed, 4, 0)
  expect(openTabs(moved)).toEqual([4, 1, 3])
  expect(openTabs(reopenTabs(moved, [2]))).toEqual([4, 1, 2, 3])
  expect(openTabs(moveTab(closed, 1, 5))).toEqual([3, 4, 1])
})

test("the next tab after a close is the nearest kept one, left first", () => {
  expect(nearestKept([1, 2, 3], [3], 3)).toBe(2)
  expect(nearestKept([1, 2, 3, 4], [2, 3], 3)).toBe(1)
  expect(nearestKept([1, 2, 3, 4], [1, 2], 1)).toBe(3)
  expect(nearestKept([1, 2], [1, 2], 2)).toBeUndefined()
})
