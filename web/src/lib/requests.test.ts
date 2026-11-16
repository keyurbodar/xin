import { expect, test } from "bun:test"
import type { RequestRow } from "../state/conversation.ts"
import type { ThreadGroups, ThreadSummary } from "../state/home.ts"
import { coalesce, onRequestsRev } from "./requests.ts"

const HOME_REQUESTS = 5

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

type Space = { readonly coordinatorId: number; readonly threads: ThreadGroups; readonly openRequests: number; readonly requestsRev: number }
type Frame = { readonly mine: Space; readonly other: Space; readonly requests: readonly RequestRow[] }

const newerElsewhere = Array.from({ length: HOME_REQUESTS }, (_, index) => request(`o${index}`, 90 + index))
const other = (requestsRev: number): Space => ({
  coordinatorId: 2,
  threads: groups(newerElsewhere.map((row) => row.conversationId)),
  openRequests: HOME_REQUESTS,
  requestsRev,
})
const asked = (requestsRev: number): Frame => ({
  mine: { coordinatorId: 1, threads: groups([10]), openRequests: 1, requestsRev },
  other: other(500),
  requests: newerElsewhere,
})
const answered = (requestsRev: number): Frame => ({
  mine: { coordinatorId: 1, threads: groups([], [10]), openRequests: 0, requestsRev },
  other: other(500),
  requests: newerElsewhere,
})

function client() {
  let reads = 0
  const refresh = coalesce(async () => {
    reads += 1
  })
  const note = onRequestsRev(() => void refresh())
  return {
    show: (frame: Frame) => note(frame.mine),
    reads: () => reads,
  }
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
}

test("a re-ask while another space fills the home window re-reads once on the held frame", async () => {
  const screen = client()
  screen.show(asked(100))
  await settle()
  expect(screen.reads()).toBe(1)
  screen.show(asked(102))
  await settle()
  expect(screen.reads()).toBe(2)
})

test("a re-ask that happened while offline re-reads once from the reconnect snapshot", async () => {
  const screen = client()
  screen.show(asked(100))
  await settle()
  screen.show(asked(102))
  screen.show(asked(102))
  await settle()
  expect(screen.reads()).toBe(2)
})

test("an answer and a re-ask seen live re-read once each", async () => {
  const screen = client()
  screen.show(asked(100))
  await settle()
  screen.show(answered(101))
  await settle()
  screen.show(asked(102))
  await settle()
  expect(screen.reads()).toBe(3)
})

test("thread status flips and another space's rev cost no request.list", async () => {
  const screen = client()
  screen.show(asked(100))
  await settle()
  const flipped: Frame = { ...asked(100), mine: { ...asked(100).mine, threads: groups([10], [11, 12]) } }
  screen.show(flipped)
  screen.show({ ...asked(100), other: other(777), requests: [request("o9", 99), ...newerElsewhere.slice(1)] })
  screen.show(asked(100))
  await settle()
  expect(screen.reads()).toBe(1)
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
  await settle()
  expect(runs).toBe(2)
  releases.shift()?.()
  await settle()
  expect(runs).toBe(2)
})
