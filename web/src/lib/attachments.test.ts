import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  blobUrl,
  createAttachments,
  isBlobType,
  kindLabel,
  MAX_ATTACHMENTS,
  rejectionOf,
  sizeLabel,
  statusLabel,
  type Upload,
} from "./attachments.ts"

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(upload: Upload) {
  const revoked: string[] = []
  URL.createObjectURL = (blob: Blob) => `blob:test/${blob instanceof File ? blob.name : "blob"}`
  URL.revokeObjectURL = (url: string) => void revoked.push(url)
  let store!: ReturnType<typeof createAttachments>
  const dispose = createRoot((disposer) => {
    store = createAttachments(() => upload)
    return disposer
  })
  return { store, revoked, dispose }
}

test("removing a file aborts its upload and revokes its preview", async () => {
  const signals: AbortSignal[] = []
  const { store, revoked } = harness((_file, _progress, signal) => {
    signals.push(signal)
    return new Promise(() => undefined)
  })
  store.add([file(10, "shot.png")])
  const [item] = store.items()
  store.remove(item!.id)
  expect(signals[0]?.aborted).toBe(true)
  expect(revoked).toEqual(["blob:test/shot.png"])
  expect(store.items()).toHaveLength(0)
})

test("clearing aborts every upload and revokes every preview", () => {
  const signals: AbortSignal[] = []
  const { store, revoked, dispose } = harness((_file, _progress, signal) => {
    signals.push(signal)
    return new Promise(() => undefined)
  })
  store.add([file(10, "a.png"), file(10, "b.png")])
  dispose()
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
  expect(revoked).toEqual(["blob:test/a.png", "blob:test/b.png"])
})

test("adding a failed file again replaces its card instead of adding a second", async () => {
  let calls = 0
  const { store } = harness(() => (++calls === 1 ? Promise.reject(new Error("shot.png: HTTP 500")) : new Promise(() => undefined)))
  store.add([file(10, "shot.png")])
  await settle()
  expect(store.items().map((item) => item.state)).toEqual([{ kind: "failed", error: "HTTP 500" }])
  store.add([file(10, "shot.png")])
  expect(store.items().map((item) => item.state.kind)).toEqual(["uploading"])
})

test("only octet-stream or image bytes count as a blob", () => {
  expect(isBlobType("application/octet-stream")).toBe(true)
  expect(isBlobType("image/png")).toBe(true)
  expect(isBlobType("text/html; charset=utf-8")).toBe(false)
  expect(isBlobType("")).toBe(false)
})

test("adding a failed file again aborts its old request and revokes its old preview", async () => {
  const signals: AbortSignal[] = []
  const { store, revoked } = harness((_file, _progress, signal) => {
    signals.push(signal)
    return signals.length === 1 ? Promise.reject(new Error("shot.png: HTTP 500")) : new Promise(() => undefined)
  })
  store.add([file(10, "shot.png")])
  await settle()
  expect(revoked).toEqual([])
  store.add([file(10, "shot.png")])
  expect(signals[0]?.aborted).toBe(true)
  expect(revoked).toEqual(["blob:test/shot.png"])
})

async function blobWith(response: Response, sha256: string) {
  const original = globalThis.fetch
  URL.createObjectURL = () => "blob:test/thumb"
  globalThis.fetch = Object.assign(async () => response, { preconnect: original.preconnect })
  try {
    return await blobUrl(sha256, "image/png").then(
      (url) => ({ url }),
      (failure: unknown) => ({ failure: String(failure) }),
    )
  } finally {
    globalThis.fetch = original
  }
}

test("blobUrl refuses a page served in place of the bytes, like a dev server's index.html", async () => {
  const html = new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } })
  expect(await blobWith(html, "c".repeat(64))).toEqual({ failure: expect.stringContaining("not file bytes") })
  const bytes = new Response(new Uint8Array([0x89, 0x50]), { headers: { "content-type": "application/octet-stream" } })
  expect(await blobWith(bytes, "d".repeat(64))).toEqual({ url: "blob:test/thumb" })
})
