import { expect, test } from "bun:test"
import { plainCell, tableCsv, tableMarkdown } from "./table-copy.ts"

test("copy as Markdown writes the alignment row and re-escapes pipes", () => {
  const text = tableMarkdown(["Name", "Qty", "Mid"], ["left", "right", "center"], [["a | b", "3", "x"]])
  expect(text).toBe("| Name | Qty | Mid |\n| --- | ---: | :---: |\n| a \\| b | 3 | x |")
})

test("copy as CSV quotes per RFC 4180 and ends rows with CRLF", () => {
  const text = tableCsv(["name", "note"], [["plain", 'say "hi", then go'], ["two\nlines", "ok"]])
  expect(text).toBe('name,note\r\nplain,"say ""hi"", then go"\r\n"two\nlines",ok')
})

test("copy as CSV drops inline Markdown", () => {
  expect(plainCell("**bold** and *em* with `code` and [link](https://x.dev)")).toBe("bold and em with code and link")
  expect(tableCsv(["h"], [["**3**"]])).toBe("h\r\n3")
})
