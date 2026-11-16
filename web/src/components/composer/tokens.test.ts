import { expect, test } from "bun:test"
import { fromText, toText } from "@ui-sdk/core/token-input"
import { composerCodec, formatToken, toInputToken } from "./tokens.ts"

test("each chip writes the text the backend already reads", () => {
  expect(formatToken({ kind: "thread", value: "12" })).toBe("@thread:12")
  expect(formatToken({ kind: "skill", value: "issues" })).toBe("@skill:issues")
  expect(formatToken({ kind: "file", value: "/projects/ingle/notes.md" })).toBe("@/projects/ingle/notes.md")
  expect(formatToken({ kind: "prompt", value: "fix" })).toBe("/fix")
})

test("a draft with chips sends their backend text in place", () => {
  const value = [
    toInputToken({ kind: "prompt", value: "fix", label: "fix" }),
    " look at ",
    toInputToken({ kind: "thread", value: "12", label: "Review the spec" }),
    " with ",
    toInputToken({ kind: "skill", value: "make-a-deck", label: "make-a-deck" }),
  ]
  expect(toText(value, composerCodec)).toBe("/fix look at @thread:12 with @skill:make-a-deck")
})

test("text that looks like a reference reads back as plain text, never as a chip", () => {
  expect(fromText("@/etc/passwd and @thread:5 /fix", composerCodec)).toEqual(["@/etc/passwd and @thread:5 /fix"])
})
