import { describe, expect, it } from "vitest"
import { DEFAULT_PREFS } from "../../src/contracts/push.ts"
import type { IntakeBatchRow } from "../../src/contracts/intake.ts"
import { notificationOf } from "./gateway.ts"

function row(kind: "user" | "report" | "question" | "job", status = "completed"): IntakeBatchRow {
  return kind === "user"
    ? { id: 1, kind, clientTs: 0, commandId: "c", text: "hi", attachments: [] }
    : { id: 2, kind, clientTs: 0, commandId: "c", threadId: "7", title: "Parser", status, text: "done" }
}

describe("what a dispatch announces", () => {
  it("pushes a question and a report, and nothing for a user message or a job", () => {
    expect(notificationOf(DEFAULT_PREFS, row("question"))).toEqual({
      threadTitle: "Parser",
      title: "Parser",
      body: "done",
      tag: "c",
      kind: "waiting",
    })
    expect(notificationOf(DEFAULT_PREFS, row("report"))).toMatchObject({ kind: "finished" })
    expect(notificationOf(DEFAULT_PREFS, row("report", "failed"))).toMatchObject({ kind: "failed" })
    expect(notificationOf(DEFAULT_PREFS, row("user"))).toBeUndefined()
    expect(notificationOf(DEFAULT_PREFS, row("job"))).toBeUndefined()
  })

  it("keeps a kind the owner switched off quiet and leaves the others alone", () => {
    const quiet = { ...DEFAULT_PREFS, finished: false }
    expect(notificationOf(quiet, row("report"))).toBeUndefined()
    expect(notificationOf(quiet, row("question"))).toMatchObject({ kind: "waiting" })
    expect(notificationOf(quiet, row("report", "failed"))).toMatchObject({ kind: "failed" })
  })
})
