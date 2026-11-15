import { expect, test } from "bun:test"
import { firstLoad } from "./loading.ts"

test("a skeleton shows while the first value is pending and never on a refetch or an error", () => {
  expect(firstLoad({ state: "unresolved" })).toBe(false)
  expect(firstLoad({ state: "pending" })).toBe(true)
  expect(firstLoad({ state: "ready" })).toBe(false)
  expect(firstLoad({ state: "refreshing" })).toBe(false)
  expect(firstLoad({ state: "errored" })).toBe(false)
})
