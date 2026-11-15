import { expect, test } from "bun:test"
import type { RequestRow } from "../state/conversation.ts"
import type { ThreadGroups, ThreadSummary } from "../state/home.ts"
import { coalesce, requestsKey } from "./requests.ts"

const thread = (id: number, status: string): ThreadSummary => ({ id, title: `T${id}`, status, run: 1 })
const groups = (waiting: readonly number[], working: readonly number[] = []): ThreadGroups => ({
  working: working.map((id) => thread(id, "working")),
  waiting: waiting.map((id) => thread(id, "waiting")),
  completed: [],
  failed: [],
  cancelled: [],
})
const request = (id: string, conversationId: number): RequestRow => ({
  id,
  conversationId,
  projectId: "p1",
  projectName: "Atlas",
  threadTitle: undefined,
  question: `Question ${id}?`,
  options: [],
  askedAt: 1,
})
const space = (threads: ThreadGroups, openRequests: number) => ({ coordinatorId: 1, threads, openRequests })

test("a frame of unrelated chatter keeps the key, so it costs no request.list", () => {
  const rows = [request("q1", 10)]
  const first = requestsKey(space(groups([10], [11]), 1), rows)
  const again = requestsKey(space(groups([10], [11]), 1), [request("q1", 10)])
  expect(again).toBe(first)
})

test("one request resolving while another opens keeps the count but changes the key", () => {
  const before = requestsKey(space(groups([10, 12]), 1), [request("q1", 10)])
  const after = requestsKey(space(groups([10, 12]), 1), [request("q2", 12)])
  expect(after).not.toBe(before)
})

test("stopping a waiting thread changes the key even though its stored question stays counted", () => {
  const before = requestsKey(space(groups([10]), 1), [request("q1", 10)])
  const stopped: ThreadGroups = { ...groups([]), cancelled: [thread(10, "cancelled")] }
  expect(requestsKey(space(stopped, 1), [])).not.toBe(before)
  expect(requestsKey(space(stopped, 1), [request("q1", 10)])).not.toBe(before)
})

test("a reconnect snapshot re-reads only when what the space depends on moved while offline", () => {
  const live = requestsKey(space(groups([10]), 1), [request("q1", 10)])
  expect(requestsKey(space(groups([10]), 1), [request("q1", 10)])).toBe(live)
  expect(requestsKey(space(groups([10, 12]), 2), [request("q2", 12), request("q1", 10)])).not.toBe(live)
})

test("another space's questions never move this space's key", () => {
  const mine = requestsKey(space(groups([10]), 1), [request("q1", 10)])
  expect(requestsKey(space(groups([10]), 1), [request("q1", 10), request("q9", 99)])).toBe(mine)
})

test("a refresh asked for while one is in flight runs once more after it, never dropped and never doubled", async () => {
  let runs = 0
  const releases: (() => void)[] = []
  const refresh = coalesce(
    () =>
      new Promise<void>((resolve) => {
        runs += 1
        releases.push(resolve)
      }),
  )
  void refresh()
  void refresh()
  void refresh()
  expect(runs).toBe(1)
  releases.shift()?.()
  await Promise.resolve()
  await Promise.resolve()
  expect(runs).toBe(2)
  releases.shift()?.()
  await Promise.resolve()
  await Promise.resolve()
  expect(runs).toBe(2)
})
