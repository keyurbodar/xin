import { expect, test } from "bun:test"
import { fileIcon, fileIconUrl } from "./file-icons.ts"

test("a file's exact name wins over its extension", () => {
  expect(fileIcon("package.json", false)).toBe("files/node")
  expect(fileIcon("tsconfig.json", false)).toBe("files/tsconfig")
  expect(fileIcon("notes.json", false)).toBe("files/brackets-yellow")
})

test("the longest compound extension wins, case-insensitively", () => {
  expect(fileIcon("types.d.ts", false)).toBe("files/ts-types")
  expect(fileIcon("App.TSX", false)).toBe("files/react-ts")
  expect(fileIcon("index.ts", false)).toBe("files/ts")
})

test("unknown files and folders fall back to the generic icons", () => {
  expect(fileIcon("blob.zzz", false)).toBe("files/document")
  expect(fileIcon("Makefile-ish", false)).toBe("files/document")
  expect(fileIcon("whatever", true)).toBe("folders/folder")
  expect(fileIcon("src", true)).toBe("folders/folder-orange-code")
})

test("a dotfile is matched by its whole name, never as an empty-stem extension", () => {
  expect(fileIcon(".gitignore", false)).toBe("files/git")
})

test("the url points into the vendored set for the theme", () => {
  expect(fileIconUrl("README.md", false, "light")).toBe("/file-icons/light/files/markdown.svg")
})
