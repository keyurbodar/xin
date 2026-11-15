/** One project's tab order. A closed tab stays in `order` as a placeholder until its undo window ends, so undo puts it back in its own slot. */
export type TabOrder = { readonly order: readonly number[]; readonly closed: readonly number[] }

export function openTabs(tabs: TabOrder): readonly number[] {
  return tabs.order.filter((id) => !tabs.closed.includes(id))
}

export function closeTabs(tabs: TabOrder, ids: readonly number[]): TabOrder {
  const closing = ids.filter((id) => tabs.order.includes(id) && !tabs.closed.includes(id))
  return { ...tabs, closed: [...tabs.closed, ...closing] }
}

export function reopenTabs(tabs: TabOrder, ids: readonly number[]): TabOrder {
  return { ...tabs, closed: tabs.closed.filter((id) => !ids.includes(id)) }
}

/** Drops the placeholders of `ids` that are still closed; a tab reopened since keeps its place. */
export function forgetTabs(tabs: TabOrder, ids: readonly number[]): TabOrder {
  const gone = tabs.closed.filter((id) => ids.includes(id))
  return { order: tabs.order.filter((id) => !gone.includes(id)), closed: tabs.closed.filter((id) => !gone.includes(id)) }
}

/** Opens a tab: a placeholder comes back in its own slot, a new tab goes at the end. */
export function openTab(tabs: TabOrder, id: number): TabOrder {
  return tabs.order.includes(id) ? reopenTabs(tabs, [id]) : { ...tabs, order: [...tabs.order, id] }
}

/** Moves a tab to `index` among the open tabs; placeholders keep their place relative to the tabs around them. */
export function moveTab(tabs: TabOrder, id: number, index: number): TabOrder {
  const rest = tabs.order.filter((entry) => entry !== id)
  const open = rest.filter((entry) => !tabs.closed.includes(entry))
  const before = open[Math.max(0, index)]
  const at = before === undefined ? rest.length : rest.indexOf(before)
  return { ...tabs, order: [...rest.slice(0, at), id, ...rest.slice(at)] }
}

/** The tab that takes over from `id` once `removed` are gone: the nearest kept one to its left, else to its right. */
export function nearestKept(order: readonly number[], removed: readonly number[], id: number): number | undefined {
  const index = order.indexOf(id)
  const kept = (entry: number): boolean => !removed.includes(entry)
  return order.slice(0, Math.max(0, index)).findLast(kept) ?? order.slice(index + 1).find(kept)
}
