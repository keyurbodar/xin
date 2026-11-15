import { expect, test } from "bun:test"
import { threadsOf } from "./threads.ts"

test("home thread summaries carry the run, defaulting to 1 when the stream omits it", () => {
  const threads = threadsOf([
    { id: 1, title: "Second run", status: "completed", run: 3, beatAt: 5 },
    { id: 2, title: "First run", status: "working" },
    { id: 3, status: "working" },
  ])
  expect(threads.map((thread) => [thread.id, thread.run])).toEqual([
    [1, 3],
    [2, 1],
  ])
})
