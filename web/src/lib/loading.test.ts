import { expect, test } from "bun:test"
import { firstLoad, firstLoadFor, settled, valueFor, type Keyed } from "./loading.ts"

test("a skeleton shows while the first value is pending and never on a refetch or an error", () => {
  expect(firstLoad({ state: "unresolved" })).toBe(false)
  expect(firstLoad({ state: "pending" })).toBe(true)
  expect(firstLoad({ state: "ready" })).toBe(false)
  expect(firstLoad({ state: "refreshing" })).toBe(false)
  expect(firstLoad({ state: "errored" })).toBe(false)
})

test("a new key counts as a first load and never shows the old key's value; a same-key refetch keeps it", () => {
  const alpha: Keyed<string> = { key: "/alpha.md", value: "alpha text" }
  expect(firstLoadFor<string>({ state: "pending", latest: undefined }, "/alpha.md")).toBe(true)
  expect(firstLoadFor({ state: "ready", latest: alpha }, "/alpha.md")).toBe(false)
  expect(valueFor({ state: "ready", latest: alpha }, "/alpha.md")).toBe("alpha text")
  expect(firstLoadFor({ state: "refreshing", latest: alpha }, "/alpha.md")).toBe(false)
  expect(valueFor({ state: "refreshing", latest: alpha }, "/alpha.md")).toBe("alpha text")
  expect(firstLoadFor({ state: "refreshing", latest: alpha }, "/beta.md")).toBe(true)
  expect(valueFor({ state: "refreshing", latest: alpha }, "/beta.md")).toBeUndefined()
  expect(valueFor({ state: "ready", latest: alpha }, "/beta.md")).toBeUndefined()
  expect(valueFor<string>({ state: "errored", latest: undefined }, "/alpha.md")).toBeUndefined()
})

test("a failed resource reads as no value instead of throwing", () => {
  expect(settled({ error: undefined, latest: 3 })).toBe(3)
  expect(settled({ error: new Error("no op drive.list"), latest: 3 })).toBeUndefined()
  expect(settled<number>({ error: undefined, latest: undefined })).toBeUndefined()
})
