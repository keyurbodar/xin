export const PAGE_SIZE = 20

/** The items on a 1-based page, clamped to the last page so a list that shrank still shows rows. */
export function pageOf<T>(items: readonly T[], page: number, size: number = PAGE_SIZE): readonly T[] {
  const last = Math.max(1, Math.ceil(items.length / size))
  const at = Math.min(Math.max(1, page), last)
  return items.slice((at - 1) * size, at * size)
}
