import { expect, test } from "bun:test"
import { fenceRenderer, hasBlock, registerBlock, toolRenderer, type BlockPayloads } from "./registry.ts"

test("built-in kinds always exist", () => {
  for (const kind of ["code", "mermaid", "table", "tool"] as const) expect(hasBlock(kind)).toBe(true)
  expect(hasBlock("fence:none")).toBe(false)
})

test("a fence registration overrides the code block for its language until unregistered", () => {
  const render = (payload: BlockPayloads["mermaid"]): string => `chart:${payload.source}`
  const unregister = registerBlock("fence:chart", render)
  expect(hasBlock("fence:chart")).toBe(true)
  expect(fenceRenderer("chart")?.({ source: "1,2", streaming: false })).toBe("chart:1,2")
  expect(fenceRenderer("ts")).toBeUndefined()
  unregister()
  expect(hasBlock("fence:chart")).toBe(false)
  expect(fenceRenderer("chart")).toBeUndefined()
})

test("tool blocks dispatch by tool name", () => {
  const unregister = registerBlock("tool:search", (call) => `${call.name}:${call.status}:${String(call.args.q)}`)
  const call: BlockPayloads["tool"] = { name: "search", callId: "c1", args: { q: "x" }, status: "done" }
  expect(toolRenderer("search")?.(call)).toBe("search:done:x")
  expect(toolRenderer("other")).toBeUndefined()
  expect(hasBlock("tool:search")).toBe(true)
  expect(hasBlock("fence:search")).toBe(false)
  unregister()
  expect(toolRenderer("search")).toBeUndefined()
})

test("a stale unregister leaves a newer registration in place", () => {
  const first = registerBlock("fence:demo", () => "first")
  const second = registerBlock("fence:demo", () => "second")
  first()
  expect(fenceRenderer("demo")?.({ source: "", streaming: false })).toBe("second")
  second()
  expect(hasBlock("fence:demo")).toBe(false)
})
