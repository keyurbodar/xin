export type Clock = {
  readonly now: () => number
  readonly set: (fire: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
}

export const browserClock: Clock = {
  now: () => Date.now(),
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A trailing debounce with a max-wait: `fire` runs `wait` ms after the last poke, and never more than
 * `maxWait` ms after the first poke of a burst, so a steady stream still fires about once a `maxWait`.
 */
export function trailing(
  fire: () => void,
  options: { readonly wait: number; readonly maxWait: number; readonly clock?: Clock | undefined },
): { readonly poke: () => void; readonly cancel: () => void } {
  const clock = options.clock ?? browserClock
  let handle: unknown
  let firstAt: number | undefined

  const cancel = (): void => {
    if (handle !== undefined) clock.clear(handle)
    handle = undefined
    firstAt = undefined
  }

  const poke = (): void => {
    const now = clock.now()
    firstAt ??= now
    if (handle !== undefined) clock.clear(handle)
    handle = clock.set(
      () => {
        handle = undefined
        firstAt = undefined
        fire()
      },
      Math.max(0, Math.min(options.wait, firstAt + options.maxWait - now)),
    )
  }

  return { poke, cancel }
}
