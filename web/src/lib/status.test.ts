import { expect, test } from "bun:test"
import { visualState } from "./status.ts"

test("backend thread statuses map onto the Signal states the cards and panels branch on", () => {
  expect(visualState("working")).toBe("working")
  expect(visualState("waiting")).toBe("needs")
  expect(visualState("completed")).toBe("done")
  expect(visualState("failed")).toBe("failed")
  expect(visualState("cancelled")).toBe("idle")
  expect(visualState("")).toBe("queued")
})
