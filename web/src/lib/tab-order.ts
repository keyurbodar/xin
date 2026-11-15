export type RemovedTab = { readonly id: number; readonly index: number }

/** Where each of `ids` sat in `order` before it was removed, in tab order. */
export function removedAt(order: readonly number[], ids: readonly number[]): readonly RemovedTab[] {
  return order.flatMap((id, index) => (ids.includes(id) ? [{ id, index }] : []))
}

/** Puts removed tabs back at their old indexes, leaving every other tab where it is now. */
export function reinsert(order: readonly number[], removed: readonly RemovedTab[]): readonly number[] {
  const next = [...order]
  for (const tab of [...removed].sort((a, b) => a.index - b.index)) {
    if (next.includes(tab.id)) continue
    next.splice(Math.min(tab.index, next.length), 0, tab.id)
  }
  return next
}

/** The tab that takes over from `id` once `removed` are gone: the nearest kept one to its left, else to its right. */
export function nearestKept(order: readonly number[], removed: readonly number[], id: number): number | undefined {
  const index = order.indexOf(id)
  const kept = (entry: number): boolean => !removed.includes(entry)
  return order.slice(0, Math.max(0, index)).findLast(kept) ?? order.slice(index + 1).find(kept)
}
