import { expect, test } from "bun:test"
import { createRevCache, createStatesCache, createTrailing, type Clock } from "./issue-cache.ts"

function fakeClock(): Clock & { readonly advance: (ms: number) => void } {
  let now = 0
  let next = 0
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  return {
    now: () => now,
    set: (run, ms) => {
      next += 1
      timers.set(next, { at: now + ms, run })
      return next
    },
    clear: (handle) => {
      timers.delete(handle as number)
    },
    advance: (ms) => {
      now += ms
      for (const [id, timer] of [...timers].toSorted(([, left], [, right]) => left.at - right.at)) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
    },
  }
}

test("a burst of revisions settles once, after the last one; the first settles at once", () => {
  const clock = fakeClock()
  const settled: number[] = []
  const note = createTrailing(275, 1_000, (rev: number) => settled.push(rev), clock)
  note(10)
  expect(settled).toEqual([10])
  note(11)
  clock.advance(100)
  note(12)
  clock.advance(100)
  note(13)
  clock.advance(274)
  expect(settled).toEqual([10])
  clock.advance(1)
  expect(settled).toEqual([10, 13])
  note(14)
  clock.advance(275)
  expect(settled).toEqual([10, 13, 14])
})

test("home frames that repeat the last rev never hold a settle back", () => {
  const clock = fakeClock()
  const settled: number[] = []
  const note = createTrailing(275, 1_000, (rev: number) => settled.push(rev), clock)
  note(1)
  note(2)
  for (let frame = 0; frame < 4; frame += 1) {
    clock.advance(100)
    note(2)
  }
  expect(settled).toEqual([1, 2])
})

test("a burst after a settle gets its own max wait, not the previous burst's", () => {
  const clock = fakeClock()
  const settled: number[] = []
  const note = createTrailing(275, 1_000, (rev: number) => settled.push(rev), clock)
  note(0)
  note(1)
  clock.advance(275)
  expect(settled).toEqual([0, 1])
  clock.advance(5_000)
  note(2)
  clock.advance(0)
  expect(settled).toEqual([0, 1])
  clock.advance(275)
  expect(settled).toEqual([0, 1, 2])
})

test("a steady stream of new revs still settles within the max wait", () => {
  const clock = fakeClock()
  const settled: number[] = []
  const note = createTrailing(275, 1_000, (rev: number) => settled.push(rev), clock)
  note(0)
  for (let rev = 1; rev <= 14; rev += 1) {
    note(rev)
    clock.advance(150)
  }
  expect(settled[1]).toBe(7)
  expect(settled.length).toBeGreaterThanOrEqual(3)
})

test("a key read twice at one revision loads once; a new revision loads again; a failure is retried", async () => {
  const cache = createRevCache<string>()
  let loads = 0
  const load = (value: string) => () => {
    loads += 1
    return Promise.resolve(value)
  }
  expect(await cache(5, "p1", load("a"))).toBe("a")
  expect(await cache(5, "p1", load("b"))).toBe("a")
  expect(loads).toBe(1)
  expect(await cache(5, "p2", load("c"))).toBe("c")
  expect(await cache(6, "p1", load("d"))).toBe("d")
  expect(loads).toBe(3)
  await expect(cache(7, "p1", () => Promise.reject(new Error("offline")))).rejects.toThrow("offline")
  await Promise.resolve()
  expect(await cache(7, "p1", load("e"))).toBe("e")
})

test("states are read once and shared until the states revision moves; issue revisions never re-read them", async () => {
  let reads = 0
  const states = createStatesCache(async () => {
    reads += 1
    return [{ id: "todo", name: `Todo ${reads}` }]
  })
  expect((await states(undefined, Promise.resolve(["todo"])))[0]?.name).toBe("Todo 1")
  expect((await states(undefined, Promise.resolve(["todo"])))[0]?.name).toBe("Todo 1")
  expect(reads).toBe(1)
  expect((await states(3, Promise.resolve(["todo"])))[0]?.name).toBe("Todo 2")
  expect((await states(3, Promise.resolve(["todo"])))[0]?.name).toBe("Todo 2")
  expect(reads).toBe(2)
  expect((await states(4, Promise.resolve(["todo"])))[0]?.name).toBe("Todo 3")
  expect(reads).toBe(3)
})

test("an unknown state id reads the states again once, and never twice for the same id", async () => {
  let reads = 0
  const answers = [[{ id: "todo" }], [{ id: "todo" }, { id: "qa" }]]
  const states = createStatesCache(async () => answers[Math.min(reads++, answers.length - 1)] ?? [])
  expect((await states(undefined, Promise.resolve(["todo", "qa"]))).map((state) => state.id)).toEqual(["todo", "qa"])
  expect(reads).toBe(2)
  await states(undefined, Promise.resolve(["gone"]))
  await states(undefined, Promise.resolve(["gone"]))
  expect(reads).toBe(3)
})

test("a failed states read is forgotten, so the next read at the same rev retries", async () => {
  let reads = 0
  const states = createStatesCache(async () => {
    reads += 1
    if (reads === 1) throw new Error("offline")
    return [{ id: "todo" }]
  })
  await expect(states(undefined, Promise.resolve(["todo"]))).rejects.toThrow("offline")
  await Promise.resolve()
  expect(await states(undefined, Promise.resolve(["todo"]))).toHaveLength(1)
  expect(reads).toBe(2)
})
