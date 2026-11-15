import { expect, test } from "bun:test"
import {
  closeTabs,
  forgetTabs,
  moveTab,
  nearestKept,
  openTab,
  openTabs,
  pruneTabs,
  reopenTabs,
  storedTabs,
  type TabOrder,
} from "./tab-order.ts"

const tabs = (...order: number[]): TabOrder => ({ order, closed: [] })

test("close T3, close T4, undo T3, undo T4 gives the original order", () => {
  const closed = closeTabs(closeTabs(tabs(1, 2, 3, 4), [3], 1), [4], 2)
  expect(openTabs(closed)).toEqual([1, 2])
  const three = reopenTabs(closed, 1)
  expect(openTabs(three)).toEqual([1, 2, 3])
  expect(openTabs(reopenTabs(three, 2))).toEqual([1, 2, 3, 4])
})

test("the same closes undone in reverse order also give the original order", () => {
  const closed = closeTabs(closeTabs(tabs(1, 2, 3, 4), [3], 1), [4], 2)
  const four = reopenTabs(closed, 2)
  expect(openTabs(four)).toEqual([1, 2, 4])
  expect(openTabs(reopenTabs(four, 1))).toEqual([1, 2, 3, 4])
})

test("close, reopen, close again, the first close expires, and undo still brings the tab back in its slot", () => {
  const first = closeTabs(tabs(1, 2, 3), [2], 1)
  const second = closeTabs(openTab(first, 2), [2], 2)
  const expired = forgetTabs(second, 1)
  expect(expired.order).toEqual([1, 2, 3])
  expect(openTabs(reopenTabs(expired, 2))).toEqual([1, 2, 3])
})

test("closing a tab that is already closed leaves its first close in charge", () => {
  const twice = closeTabs(closeTabs(tabs(1, 2, 3), [2], 1), [2], 2)
  expect(twice.closed).toEqual([{ id: 2, closeId: 1 }])
  expect(openTabs(reopenTabs(forgetTabs(twice, 2), 1))).toEqual([1, 2, 3])
})

test("tabs closed together come back together in their slots", () => {
  const closed = closeTabs(tabs(1, 2, 3, 4), [1, 3], 1)
  expect(openTabs(closed)).toEqual([2, 4])
  expect(openTabs(reopenTabs(closed, 1))).toEqual([1, 2, 3, 4])
})

test("a tab already open again keeps its place and is not duplicated", () => {
  const reopened = openTab(closeTabs(tabs(1, 2, 3), [2], 1), 2)
  expect(reopened).toEqual({ order: [1, 2, 3], closed: [] })
  expect(openTabs(forgetTabs(reopened, 1))).toEqual([1, 2, 3])
})

test("an ended undo window drops the placeholder, and a new tab goes at the end", () => {
  const forgotten = forgetTabs(closeTabs(tabs(1, 2, 3), [2], 1), 1)
  expect(forgotten).toEqual({ order: [1, 3], closed: [] })
  expect(openTab(forgotten, 2).order).toEqual([1, 3, 2])
})

test("a drag counts only open tabs, past a placeholder", () => {
  const closed = closeTabs(tabs(1, 2, 3, 4), [2], 1)
  expect(openTabs(moveTab(closed, 1, 2))).toEqual([3, 4, 1])
  expect(openTabs(moveTab(closed, 4, 1))).toEqual([1, 4, 3])
  expect(openTabs(reopenTabs(moveTab(closed, 4, 0), 1))).toEqual([4, 1, 2, 3])
})

test("pruning a deleted thread drops its placeholder too, so it opens again if the id comes back", () => {
  const pruned = pruneTabs(closeTabs(tabs(1, 2, 3), [2], 1), new Set([1, 3]))
  expect(pruned).toEqual({ order: [1, 3], closed: [] })
  expect(openTabs(openTab(pruned, 2))).toEqual([1, 3, 2])
})

test("placeholders never reach storage", () => {
  const closed = closeTabs(tabs(1, 2, 3), [2], 1)
  const stored = storedTabs({ threads: closed.order, closed: closed.closed, view: "overview" })
  expect(stored).toEqual({ threads: [1, 3], view: "overview" })
  expect(JSON.stringify(stored)).not.toContain("closed")
})

test("the next tab after a close is the nearest kept one, left first", () => {
  expect(nearestKept([1, 2, 3], [3], 3)).toBe(2)
  expect(nearestKept([1, 2, 3, 4], [2, 3], 3)).toBe(1)
  expect(nearestKept([1, 2, 3, 4], [1, 2], 1)).toBe(3)
  expect(nearestKept([1, 2], [1, 2], 2)).toBeUndefined()
})
