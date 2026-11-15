export function wrapFocus<T>(items: readonly T[], active: T | null, backwards: boolean): T | undefined {
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) return undefined
  const index = active === null ? -1 : items.indexOf(active)
  if (backwards) return index <= 0 ? last : undefined
  return index === -1 || index === items.length - 1 ? first : undefined
}
