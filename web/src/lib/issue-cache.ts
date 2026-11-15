/** Timers the debounce runs on; tests pass a fake one. */
export type Clock = {
  readonly now: () => number
  readonly set: (run: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Settles a stream of values: the first settles at once, so the first screen never waits; a repeat of the last value is
 * ignored, so unrelated frames never hold a settle back; a burst of new values settles `delayMs` after its last one, and
 * no later than `maxWaitMs` after its first, so a steady stream still settles about once per `maxWaitMs`.
 */
export function createTrailing<T>(
  delayMs: number,
  maxWaitMs: number,
  settle: (value: T) => void,
  clock: Clock = realClock,
): (value: T) => void {
  let noted: { readonly value: T } | undefined
  let started: number | undefined
  let pending: unknown
  const fire = (): void => {
    pending = undefined
    started = undefined
    if (noted !== undefined) settle(noted.value)
  }
  return (value) => {
    if (noted === undefined) {
      noted = { value }
      settle(value)
      return
    }
    if (Object.is(noted.value, value)) return
    noted = { value }
    started ??= clock.now()
    if (pending !== undefined) clock.clear(pending)
    pending = clock.set(fire, Math.max(0, Math.min(delayMs, started + maxWaitMs - clock.now())))
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
 * The organization's states, read once per revision beside the list or issue that needs them, so a rename or reorder
 * shows with the next change. A read that names an id the states lack reads them again, at most once per id, so a
 * state that really is gone cannot loop; a failed read is forgotten so the next one retries.
 */
export function createStatesCache<S extends { readonly id: string }>(
  load: () => Promise<readonly S[]>,
): (rev: number, seen: Promise<readonly string[]>) => Promise<readonly S[]> {
  let current: { readonly rev: number; readonly value: Promise<readonly S[]> } | undefined
  const retried = new Set<string>()
  const read = (rev: number): Promise<readonly S[]> => {
    const value = load()
    current = { rev, value }
    value.catch(() => {
      if (current?.value === value) current = undefined
    })
    return value
  }
  return async (rev, seen) => {
    const pending = current !== undefined && current.rev === rev ? current.value : read(rev)
    const [states, ids] = await Promise.all([pending, seen])
    const known = new Set(states.map((state) => state.id))
    const unknown = ids.filter((id) => !known.has(id) && !retried.has(id))
    if (unknown.length === 0) return states
    for (const id of unknown) retried.add(id)
    return read(rev)
  }
}
