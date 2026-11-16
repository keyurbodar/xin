import { expect, test } from "bun:test"
import { toText } from "@ui-sdk/core/token-input"
import { composerCodec, formatToken, parseDraft } from "./tokens.ts"

test("each chip writes the text the backend already reads", () => {
  expect(formatToken({ kind: "thread", value: "12" })).toBe("@thread:12")
  expect(formatToken({ kind: "skill", value: "issues" })).toBe("@skill:issues")
  expect(formatToken({ kind: "file", value: "/projects/ingle/notes.md" })).toBe("@/projects/ingle/notes.md")
  expect(formatToken({ kind: "prompt", value: "fix" })).toBe("/fix")
})

test("a draft round-trips through its chips", () => {
  const text = "/fix look at @thread:12 with @skill:make-a-deck and @/projects/ingle/notes.md please"
  const value = parseDraft(text)
  expect(value).toEqual([
    { type: "prompt", value: "fix", label: "fix" },
    " look at ",
    { type: "thread", value: "12", label: "Thread 12" },
    " with ",
    { type: "skill", value: "make-a-deck", label: "make-a-deck" },
    " and ",
    { type: "file", value: "/projects/ingle/notes.md", label: "notes.md" },
    " please",
  ])
  expect(toText(value, composerCodec)).toBe(text)
})

test("a slash after the start and a bare @ stay text", () => {
  expect(parseDraft("and/or @ home")).toEqual(["and/or @ home"])
})
