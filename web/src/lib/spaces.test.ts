import { expect, test } from "bun:test"
import type { RequestRow } from "../state/conversation.ts"
import type { ThreadGroups } from "../state/home.ts"
import { spaceRequests } from "./spaces.ts"

const request = (id: string, conversationId: number): RequestRow => ({
  id,
  kind: "ask_user",
  conversationId,
  projectId: "prj_1",
  projectName: "Atlas",
  threadTitle: undefined,
  question: "Which one?",
  options: [],
  askedAt: 1,
})

const empty: ThreadGroups = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }

test("a space's questions are its coordinator's and its threads', not a sibling space's in the same project", () => {
  const threads: ThreadGroups = {
    ...empty,
    waiting: [{ id: 21, title: "Ask", status: "waiting", run: 1 }],
    completed: [{ id: 22, title: "Done", status: "completed", run: 1 }],
  }
  const rows = [request("a", 10), request("b", 21), request("c", 31), request("d", 22)]
  expect(spaceRequests({ coordinatorId: 10, threads }, rows).map((row) => row.id)).toEqual(["a", "b", "d"])
  expect(spaceRequests({ coordinatorId: 30, threads: empty }, rows)).toEqual([])
})
