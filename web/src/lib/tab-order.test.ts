import { expect, test } from "bun:test"
import { nearestKept, reinsert, removedAt } from "./tab-order.ts"

test("undoing an older close reopens only its own tab, at its old index", () => {
  const first = removedAt([1, 2, 3, 4], [1])
  const second = removedAt([2, 3, 4], [2])
  expect(reinsert([3, 4], first)).toEqual([1, 3, 4])
  expect(reinsert(reinsert([3, 4], second), first)).toEqual([1, 2, 3, 4])
})

test("tabs moved or opened after a close keep their place when it is undone", () => {
  const closed = removedAt([1, 2, 3, 4], [3, 4])
  expect(closed).toEqual([{ id: 3, index: 2 }, { id: 4, index: 3 }])
  expect(reinsert([2, 1, 9], closed)).toEqual([2, 1, 3, 4, 9])
})

test("a tab already open again is not duplicated, and an index past the end appends", () => {
  expect(reinsert([1, 4], removedAt([1, 2, 3, 4], [2, 4]))).toEqual([1, 2, 4])
  expect(reinsert([], [{ id: 7, index: 5 }])).toEqual([7])
})

test("the next tab after a close is the nearest kept one, left first", () => {
  expect(nearestKept([1, 2, 3, 4], [2, 3], 3)).toBe(1)
  expect(nearestKept([1, 2, 3, 4], [1, 2], 1)).toBe(3)
  expect(nearestKept([1, 2], [1, 2], 2)).toBeUndefined()
})
