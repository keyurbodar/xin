/** Timers the debounce runs on; tests pass a fake one. */
export type Clock = {
  readonly set: (run: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
}

export const realClock: Clock = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Settles a stream of values: the first value settles at once, so the first screen never waits, and after that a burst
 * settles once, `delayMs` after its last value.
 */
export function createTrailing<T>(delayMs: number, settle: (value: T) => void, clock: Clock = realClock): (value: T) => void {
  let first = true
  let pending: unknown
  return (value) => {
    if (first) {
      first = false
      settle(value)
      return
    }
    if (pending !== undefined) clock.clear(pending)
    pending = clock.set(() => {
      pending = undefined
      settle(value)
    }, delayMs)
  }
}

/**
 * One promise per key at one revision: a remount at the same revision reuses it and sends nothing, a new revision
 * replaces it, and a failure is forgotten so the next read retries.
 */
export function createRevCache<T>(): (rev: number, key: string, load: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, { readonly rev: number; readonly value: Promise<T> }>()
  return (rev, key, load) => {
    const found = entries.get(key)
    if (found !== undefined && found.rev === rev) return found.value
    const value = load()
    entries.set(key, { rev, value })
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key)
    })
    return value
  }
}

/**
 * The organization's states, read once and read again only when a list or issue names a state id the last read did not
 * have; each unknown id triggers at most one re-read, so a state that really is gone cannot loop.
 */
export function createStatesCache<S extends { readonly id: string }>(
  load: () => Promise<readonly S[]>,
): (seen: readonly string[]) => Promise<readonly S[]> {
  let current: Promise<readonly S[]> | undefined
  const retried = new Set<string>()
  const read = (): Promise<readonly S[]> => {
    const value = load()
    current = value
    value.catch(() => {
      if (current === value) current = undefined
    })
    return value
  }
  return async (seen) => {
    const states = await (current ?? read())
    const known = new Set(states.map((state) => state.id))
    const unknown = seen.filter((id) => !known.has(id) && !retried.has(id))
    if (unknown.length === 0) return states
    for (const id of unknown) retried.add(id)
    return read()
  }
}
