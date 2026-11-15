/** A closed tab's placeholder, tagged with the close that made it so only that close's undo or expiry touches it. */
export type Placeholder = { readonly id: number; readonly closeId: number }

/** One project's tab order. A closed tab stays in `order` as a placeholder until its undo window ends, so undo puts it back in its own slot. */
export type TabOrder = { readonly order: readonly number[]; readonly closed: readonly Placeholder[] }

const isClosed = (tabs: TabOrder, id: number): boolean => tabs.closed.some((entry) => entry.id === id)

export function openTabs(tabs: TabOrder): readonly number[] {
  return tabs.order.filter((id) => !isClosed(tabs, id))
}

export function closeTabs(tabs: TabOrder, ids: readonly number[], closeId: number): TabOrder {
  const closing = ids.filter((id) => tabs.order.includes(id) && !isClosed(tabs, id))
  return { ...tabs, closed: [...tabs.closed, ...closing.map((id) => ({ id, closeId }))] }
}

export function reopenTabs(tabs: TabOrder, closeId: number): TabOrder {
  return { ...tabs, closed: tabs.closed.filter((entry) => entry.closeId !== closeId) }
}

/** Ends one close's undo window: its placeholders leave the order; a tab reopened or closed again since is untouched. */
export function forgetTabs(tabs: TabOrder, closeId: number): TabOrder {
  const gone = tabs.closed.filter((entry) => entry.closeId === closeId).map((entry) => entry.id)
  return {
    order: tabs.order.filter((id) => !gone.includes(id)),
    closed: tabs.closed.filter((entry) => entry.closeId !== closeId),
  }
}

/** Opens a tab: a placeholder comes back in its own slot, a new tab goes at the end. */
export function openTab(tabs: TabOrder, id: number): TabOrder {
  if (!tabs.order.includes(id)) return { ...tabs, order: [...tabs.order, id] }
  return { ...tabs, closed: tabs.closed.filter((entry) => entry.id !== id) }
}

/** Moves a tab to `index` among the open tabs; placeholders keep their place relative to the tabs around them. */
export function moveTab(tabs: TabOrder, id: number, index: number): TabOrder {
  const rest = tabs.order.filter((entry) => entry !== id)
  const open = rest.filter((entry) => !isClosed(tabs, entry))
  const before = open[Math.max(0, index)]
  const at = before === undefined ? rest.length : rest.indexOf(before)
  return { ...tabs, order: [...rest.slice(0, at), id, ...rest.slice(at)] }
}

/** Drops tabs and placeholders whose thread no longer exists. */
export function pruneTabs(tabs: TabOrder, live: ReadonlySet<number>): TabOrder {
  return { order: tabs.order.filter((id) => live.has(id)), closed: tabs.closed.filter((entry) => live.has(entry.id)) }
}

/** What a project's tabs persist as: open tabs only, so placeholders never outlive the page. */
export function storedTabs<T extends { readonly threads: readonly number[]; readonly closed: readonly Placeholder[] }>(
  tabs: T,
): Omit<T, "closed"> {
  const { closed, ...rest } = tabs
  return { ...rest, threads: openTabs({ order: tabs.threads, closed }) }
}

/** The tab that takes over from `id` once `removed` are gone: the nearest kept one to its left, else to its right. */
export function nearestKept(order: readonly number[], removed: readonly number[], id: number): number | undefined {
  const index = order.indexOf(id)
  const kept = (entry: number): boolean => !removed.includes(entry)
  return order.slice(0, Math.max(0, index)).findLast(kept) ?? order.slice(index + 1).find(kept)
}
