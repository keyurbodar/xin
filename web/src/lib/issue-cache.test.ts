import { expect, test } from "bun:test"
import { createRevCache, createStatesCache, createTrailing, type Clock } from "./issue-cache.ts"

function fakeClock(): Clock & { readonly advance: (ms: number) => void } {
  let now = 0
  let next = 0
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  return {
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
  const note = createTrailing(275, (rev: number) => settled.push(rev), clock)
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

test("states are read once, again once for an unknown id, and never twice for the same unknown id", async () => {
  let reads = 0
  const answers = [[{ id: "todo" }], [{ id: "todo" }, { id: "qa" }], [{ id: "todo" }, { id: "qa" }]]
  const states = createStatesCache(async () => answers[Math.min(reads++, answers.length - 1)] ?? [])
  expect((await states(["todo"])).map((state) => state.id)).toEqual(["todo"])
  expect(await states(["todo"])).toHaveLength(1)
  expect(reads).toBe(1)
  expect((await states(["todo", "qa"])).map((state) => state.id)).toEqual(["todo", "qa"])
  expect(reads).toBe(2)
  expect(await states(["qa"])).toHaveLength(2)
  expect(reads).toBe(2)
  await states(["gone"])
  await states(["gone"])
  expect(reads).toBe(3)
})
