import { expect, test } from "bun:test"
import { kindLabel, MAX_ATTACHMENTS, rejectionOf, sizeLabel, statusLabel } from "./attachments.ts"

const file = (size: number, name = "a.png", type = "image/png") => new File([new Uint8Array(size)], name, { type })

test("sizes read as whole kilobytes and one-decimal megabytes", () => {
  expect(sizeLabel(512)).toBe("512 B")
  expect(sizeLabel(215 * 1024)).toBe("215 KB")
  expect(sizeLabel(1_363_149)).toBe("1.3 MB")
})

test("the kind is the extension, else the MIME subtype", () => {
  expect(kindLabel("shot.png", "image/png")).toBe("PNG")
  expect(kindLabel("logo", "image/svg+xml")).toBe("SVG")
  expect(kindLabel("blob", "")).toBe("File")
})

test("a file is refused when empty, over 50 MB, or past the per-message count", () => {
  expect(rejectionOf(file(10), 0)).toBeUndefined()
  expect(rejectionOf(file(0), 0)).toBe("Empty file")
  expect(rejectionOf(file(51 * 1024 * 1024), 0)).toBe("Too big · 50 MB max")
  expect(rejectionOf(file(10), MAX_ATTACHMENTS)).toBe("12 files per message")
})

test("upload status reads Preparing, a percent, then Finishing", () => {
  expect(statusLabel({ kind: "uploading", progress: 0 })).toBe("Preparing")
  expect(statusLabel({ kind: "uploading", progress: 0.42 })).toBe("42%")
  expect(statusLabel({ kind: "uploading", progress: 1 })).toBe("Finishing")
  expect(statusLabel({ kind: "failed", error: "HTTP 500" })).toBe("HTTP 500")
})
