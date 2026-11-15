import { expect, test } from "bun:test"
import { nearestKept, reinsert, removedAt } from "./tab-order.ts"

const closeOne = (order: readonly number[], id: number) => ({
  order: order.filter((entry) => entry !== id),
  removed: removedAt(order, [id]),
})

test("close A then B, undo A then B, puts both back in order", () => {
  const a = closeOne([1, 2, 3, 4], 1)
  const b = closeOne(a.order, 2)
  const afterA = reinsert(b.order, a.removed)
  expect(afterA).toEqual([1, 3, 4])
  expect(reinsert(afterA, b.removed)).toEqual([1, 2, 3, 4])
})

test("close A then B, undo B then A, puts both back in order", () => {
  const a = closeOne([1, 2, 3, 4], 1)
  const b = closeOne(a.order, 2)
  const afterB = reinsert(b.order, b.removed)
  expect(afterB).toEqual([2, 3, 4])
  expect(reinsert(afterB, a.removed)).toEqual([1, 2, 3, 4])
})

test("a closed tab returns after the nearest kept tab on its left when nothing follows it", () => {
  const c = closeOne([1, 2, 3], 3)
  const b = closeOne(c.order, 2)
  expect(reinsert(b.order, c.removed)).toEqual([1, 3])
  expect(reinsert(reinsert(b.order, c.removed), b.removed)).toEqual([1, 2, 3])
})

test("tabs closed together come back together, and tabs moved since keep their place", () => {
  expect(reinsert([1, 2], removedAt([1, 2, 3, 4], [3, 4]))).toEqual([1, 2, 3, 4])
  expect(reinsert([3], removedAt([1, 2, 3], [1, 2]))).toEqual([1, 2, 3])
  expect(reinsert([2, 1, 9], removedAt([1, 2, 3], [3]))).toEqual([2, 3, 1, 9])
})

test("a tab already open again is not duplicated, and a tab with no open neighbour goes to the end", () => {
  expect(reinsert([1, 2, 4], removedAt([1, 2, 4], [2]))).toEqual([1, 2, 4])
  expect(reinsert([7], removedAt([1, 2], [1]))).toEqual([7, 1])
})

test("the next tab after a close is the nearest kept one, left first", () => {
  expect(nearestKept([1, 2, 3, 4], [2, 3], 3)).toBe(1)
  expect(nearestKept([1, 2, 3, 4], [1, 2], 1)).toBe(3)
  expect(nearestKept([1, 2], [1, 2], 2)).toBeUndefined()
})
