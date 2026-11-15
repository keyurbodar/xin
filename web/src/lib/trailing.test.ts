import { expect, test } from "bun:test"
import { trailing, type Clock } from "./trailing.ts"

function fakeClock(): Clock & { readonly advance: (ms: number) => void } {
  let now = 0
  let timers: { id: number; at: number; fire: () => void }[] = []
  let next = 0
  return {
    now: () => now,
    set: (fire, ms) => {
      next += 1
      timers.push({ id: next, at: now + ms, fire })
      return next
    },
    clear: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle)
    },
    advance: (ms) => {
      const until = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        timers = timers.filter((timer) => timer !== due)
        now = due.at
        due.fire()
      }
      now = until
    },
  }
}

const options = (clock: Clock) => ({ wait: 275, maxWait: 1000, clock })

test("a burst fires once, the wait after its last poke", () => {
  const clock = fakeClock()
  const fired: number[] = []
  const debounced = trailing(() => fired.push(clock.now()), options(clock))
  debounced.poke()
  clock.advance(100)
  debounced.poke()
  clock.advance(100)
  debounced.poke()
  clock.advance(274)
  expect(fired).toEqual([])
  clock.advance(1)
  expect(fired).toEqual([475])
})

test("a steady stream still fires at the max-wait, then starts a new burst", () => {
  const clock = fakeClock()
  const fired: number[] = []
  const debounced = trailing(() => fired.push(clock.now()), options(clock))
  for (let step = 0; step < 12; step += 1) {
    debounced.poke()
    clock.advance(200)
  }
  expect(fired).toEqual([1000, 2000])
})

test("cancel drops a pending fire", () => {
  const clock = fakeClock()
  let fired = 0
  const debounced = trailing(() => (fired += 1), options(clock))
  debounced.poke()
  debounced.cancel()
  clock.advance(2000)
  expect(fired).toBe(0)
})
