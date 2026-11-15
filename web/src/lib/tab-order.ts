/** A closed tab and its neighbours at close time, nearest first: `following` skips tabs closed with it, `preceding` does not. */
export type RemovedTab = {
  readonly id: number
  readonly following: readonly number[]
  readonly preceding: readonly number[]
}

/** Each of `ids` with its neighbours in `order`, in tab order. */
export function removedAt(order: readonly number[], ids: readonly number[]): readonly RemovedTab[] {
  return order.flatMap((id, index) =>
    ids.includes(id)
      ? [
          {
            id,
            following: order.slice(index + 1).filter((entry) => !ids.includes(entry)),
            preceding: order.slice(0, index).reverse(),
          },
        ]
      : [],
  )
}

/** Puts each removed tab back before its nearest following tab still open, else after its nearest preceding one, else at the end. */
export function reinsert(order: readonly number[], removed: readonly RemovedTab[]): readonly number[] {
  const next = [...order]
  for (const tab of removed) {
    if (next.includes(tab.id)) continue
    const before = tab.following.find((id) => next.includes(id))
    const after = tab.preceding.find((id) => next.includes(id))
    const at = before !== undefined ? next.indexOf(before) : after !== undefined ? next.indexOf(after) + 1 : next.length
    next.splice(at, 0, tab.id)
  }
  return next
}

/** The tab that takes over from `id` once `removed` are gone: the nearest kept one to its left, else to its right. */
export function nearestKept(order: readonly number[], removed: readonly number[], id: number): number | undefined {
  const index = order.indexOf(id)
  const kept = (entry: number): boolean => !removed.includes(entry)
  return order.slice(0, Math.max(0, index)).findLast(kept) ?? order.slice(index + 1).find(kept)
}
