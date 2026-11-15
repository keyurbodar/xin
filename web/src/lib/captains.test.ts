import { expect, test } from "bun:test"
import type { ThreadGroups, ThreadSummary } from "../state/home.ts"
import { captainModel, crewOf, offersSideThread, parseCaptainDetail, parseCaptainRows } from "./captains.ts"

const profile = {
  id: "cpt_1",
  name: "Bosun",
  alias: "bosun",
  avatarSeed: "bosun",
  description: "Runs the crew",
  projectId: "prj_1",
  spaceId: "spc_cpt_1",
  coordinatorId: 10,
  archived: false,
  createdAt: 1_000,
}

const coordinator = { provider: "anthropic", modelId: "claude-sonnet" }

test("a new Captain starts on the project coordinator's model when nothing is picked", () => {
  expect(captainModel("", coordinator)).toEqual(coordinator)
})

test("a picked model wins over the coordinator's, and a slash in the model id survives", () => {
  expect(captainModel("openrouter/vendor/model", coordinator)).toEqual({ provider: "openrouter", modelId: "vendor/model" })
})

test("with no coordinator model and no pick there is nothing to create with", () => {
  expect(captainModel("", undefined)).toBeUndefined()
})

test("a Captain without a model offers no side thread", () => {
  expect(offersSideThread(null)).toBe(false)
  expect(offersSideThread(undefined)).toBe(false)
  expect(offersSideThread(coordinator)).toBe(true)
})

test("the home captains part parses profiles with crew counts and drops malformed rows", () => {
  const rows = parseCaptainRows({
    captains: [
      { ...profile, crew: { total: 3, working: 1, waiting: 1, failed: 0 } },
      { id: "cpt_2", name: "No space" },
      { ...profile, id: "cpt_3", alias: "quiet", avatarSeed: undefined, description: undefined, crew: undefined },
    ],
  })
  expect(rows).toEqual([
    { ...profile, crew: { total: 3, working: 1, waiting: 1, failed: 0 } },
    { ...profile, id: "cpt_3", alias: "quiet", avatarSeed: "quiet", description: "", crew: { total: 0, working: 0, waiting: 0, failed: 0 } },
  ])
  expect(parseCaptainRows(undefined)).toEqual([])
})

test("captain.get parses the standing files, the model and the crew", () => {
  const detail = parseCaptainDetail({
    ...profile,
    model: coordinator,
    notes: "n",
    rules: "r",
    crewRules: "c",
    crew: [
      { threadId: 4, title: "Fix", status: "waiting", run: 2, idleMs: 5, statusLine: "asking", report: "done" },
      { threadId: 5, title: "Bad", status: "sleeping" },
    ],
  })
  expect(detail.model).toEqual(coordinator)
  expect([detail.notes, detail.rules, detail.crewRules]).toEqual(["n", "r", "c"])
  expect(detail.crew).toEqual([{ threadId: 4, title: "Fix", status: "waiting", run: 2, idleMs: 5, statusLine: "asking", report: "done" }])
  expect(parseCaptainDetail({ ...profile, model: null }).model).toBeNull()
  expect(() => parseCaptainDetail({ name: "x" })).toThrow()
})

const thread = (id: number, beatAt: number, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: `T${id}`,
  status: "working",
  run: 1,
  beatAt,
  ...extra,
})

test("the crew comes from home's thread groups, most recently active first, with the report cut to 400", () => {
  const groups: ThreadGroups = {
    working: [thread(1, 900, { statusLine: "reading" })],
    waiting: [thread(2, 990, { status: "waiting", run: 3 })],
    completed: [thread(3, 500, { status: "completed", result: "x".repeat(500) })],
    failed: [],
    cancelled: [],
  }
  const crew = crewOf(groups, 1_000)
  expect(crew.map((member) => [member.threadId, member.status, member.idleMs, member.run])).toEqual([
    [2, "waiting", 10, 3],
    [1, "working", 100, 1],
    [3, "completed", 500, 1],
  ])
  expect(crew[1]?.statusLine).toBe("reading")
  expect(crew[2]?.report).toHaveLength(400)
})
