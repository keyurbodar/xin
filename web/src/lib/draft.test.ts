import { expect, test } from "bun:test"
import { pendingDraftFor, setPendingDraft, takePendingDraft } from "./draft.ts"

test("a pending draft reaches only its own conversation and is cleared once used", () => {
  setPendingDraft(3, "About plan.md: ")
  expect(takePendingDraft(9)).toBeUndefined()
  expect(pendingDraftFor(3)).toBe("About plan.md: ")
  expect(takePendingDraft(3)).toBe("About plan.md: ")
  expect(takePendingDraft(3)).toBeUndefined()
  expect(pendingDraftFor(3)).toBeUndefined()
})
