import { expect, test } from "bun:test"
import { parseBlocks, splitRow } from "./markdown-parse.ts"

test("a GFM table keeps its alignment row", () => {
  const [table] = parseBlocks("| Name | Qty | Note |\n| :-- | --: | :-: |\n| apple | 3 | ok |")
  expect(table).toEqual({
    kind: "table",
    header: ["Name", "Qty", "Note"],
    align: ["left", "right", "center"],
    rows: [["apple", "3", "ok"]],
    streaming: false,
  })
})

test("escaped pipes stay inside their cell", () => {
  expect(splitRow("| a \\| b | `x` |")).toEqual(["a | b", "`x`"])
  expect(splitRow("left | right \\|")).toEqual(["left", "right |"])
  const [table] = parseBlocks("a | b\n--- | ---\n1 \\| 2 | **3**")
  expect(table?.kind === "table" ? table.rows : []).toEqual([["1 | 2", "**3**"]])
})

test("a delimiter row with the wrong column count is not a table", () => {
  const blocks = parseBlocks("| a | b |\n| --- |\n| 1 | 2 |")
  expect(blocks.map((block) => block.kind)).toEqual(["paragraph"])
})

test("short and long rows are padded or trimmed to the header", () => {
  const [table] = parseBlocks("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")
  expect(table?.kind === "table" ? table.rows : []).toEqual([
    ["1", ""],
    ["1", "2"],
  ])
})

test("an unclosed fence at the end of streaming text is a streaming code block", () => {
  const [prose, code] = parseBlocks("Here:\n\n```ts\nconst a = 1\nconst b", true)
  expect(prose).toEqual({ kind: "paragraph", text: "Here:" })
  expect(code).toEqual({ kind: "fence", lang: "ts", source: "const a = 1\nconst b", streaming: true })
})

test("a closed fence is final while the rest of the message streams", () => {
  const [code, prose] = parseBlocks("```mermaid\ngraph TD\n  A-->B\n```\nmore", true)
  expect(code).toEqual({ kind: "fence", lang: "mermaid", source: "graph TD\n  A-->B", streaming: false })
  expect(prose?.kind).toBe("paragraph")
})

test("an unclosed fence in finished text is a plain code block", () => {
  const [code] = parseBlocks("```\nx")
  expect(code).toEqual({ kind: "fence", lang: "", source: "x", streaming: false })
})

test("a closing fence needs at least as many backticks as the opening", () => {
  const [code] = parseBlocks("````md\n```js\nx\n```\n````")
  expect(code).toEqual({ kind: "fence", lang: "md", source: "```js\nx\n```", streaming: false })
})

test("a streaming table renders its partial last row", () => {
  const [table] = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n| 3", true)
  expect(table).toEqual({
    kind: "table",
    header: ["a", "b"],
    align: ["left", "left"],
    rows: [
      ["1", "2"],
      ["3", ""],
    ],
    streaming: true,
  })
})

test("a streaming table shows its header while the delimiter row is still arriving", () => {
  const [table] = parseBlocks("| a | b |\n|--", true)
  expect(table).toEqual({ kind: "table", header: ["a", "b"], align: ["left", "left"], rows: [], streaming: true })
  expect(parseBlocks("| a | b |\n|--").map((block) => block.kind)).toEqual(["paragraph"])
})

test("a table followed by prose is final even while streaming", () => {
  const [table] = parseBlocks("| a |\n|---|\n| 1 |\n\nafter", true)
  expect(table?.kind === "table" ? table.streaming : undefined).toBe(false)
})

test("headings, lists and quotes keep their kinds", () => {
  const kinds = parseBlocks("# Title\n- a\n- b\n1. one\n> quoted\nplain").map((block) => block.kind)
  expect(kinds).toEqual(["heading", "list", "list", "quote", "paragraph"])
})
