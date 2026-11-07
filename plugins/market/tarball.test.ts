import { describe, expect, it } from "vitest"
import type { JsonValue } from "@earendil-works/chord"
import type { BundleRow } from "../../src/kernel/index.ts"
import { extractBundle, fetchTarball, inlineFiles, MAX_FILE_BYTES, tarballAllowed } from "./tarball.ts"
import { gzip, integrityOf, tarball, ustar } from "../../test/plugins/market.ts"

const manifest = (xin: unknown): string => JSON.stringify({ name: "demo", version: "1.0.0", xin })

describe("extractBundle", () => {
  it("round trips a gzipped ustar with a reader for referenced files", async () => {
    const xin = { bundle: [{ id: "skill", plugin: "skill", config: { markdown: { $file: "skills/research.md" } } }] }
    const bytes = await tarball({
      "package.json": manifest(xin),
      "skills/research.md": "# Research",
    })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.xin).toEqual(xin)
    expect(found.value.read("skills/research.md")).toBe("# Research")
    expect(found.value.read("missing.md")).toBeUndefined()
  })

  it("reads a file whose path needs the ustar prefix field", async () => {
    const path = `${"a".repeat(60)}/${"b".repeat(60)}.md`
    const bytes = await gzip(
      ustar([
        { path: "package/package.json", data: manifest({ bundle: [] }) },
        { path: `package/${path}`, data: "deep" },
      ]),
    )
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.read(path)).toBe("deep")
  })

  it("skips directories and entries outside the package", async () => {
    const bytes = await gzip(
      ustar([
        { path: "package/", data: "", type: "5" },
        { path: "other/package.json", data: "{}" },
        { path: "package/../evil.md", data: "evil" },
        { path: "package/package.json", data: manifest({ bundle: [] }) },
      ]),
    )
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.xin).toEqual({ bundle: [] })
    expect(found.value.read("evil.md")).toBeUndefined()
  })

  it("refuses bytes that do not match the integrity", async () => {
    const bytes = await tarball({ "package.json": manifest({ bundle: [] }) })
    const other = await tarball({ "package.json": manifest({ bundle: [] }), "a.md": "a" })
    const found = await extractBundle({ bytes, integrity: await integrityOf(other) })
    expect(found).toMatchObject({ ok: false, error: { kind: "integrity" } })
  })

  it("refuses another integrity algorithm", async () => {
    const bytes = await tarball({ "package.json": manifest({ bundle: [] }) })
    const found = await extractBundle({ bytes, integrity: "sha1-AAAA" })
    expect(found).toMatchObject({ ok: false, error: { kind: "algorithm" } })
  })

  it("refuses malformed integrity base64", async () => {
    const bytes = await tarball({ "package.json": manifest({ bundle: [] }) })
    const found = await extractBundle({ bytes, integrity: "sha512-%%%" })
    expect(found).toMatchObject({ ok: false, error: { kind: "integrity" } })
  })

  it("refuses more than 4 MiB unpacked", async () => {
    const large = new Uint8Array(5 * 1024 * 1024)
    const bytes = await tarball({ "package.json": manifest({ bundle: [] }), "large.bin": large })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toMatchObject({ ok: false, error: { kind: "size" } })
  })

  it("refuses a tarball without package.json", async () => {
    const bytes = await tarball({ "readme.md": "no manifest" })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toMatchObject({ ok: false, error: { kind: "manifest" } })
  })

  it("refuses invalid package.json", async () => {
    const bytes = await tarball({ "package.json": "{" })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toMatchObject({ ok: false, error: { kind: "manifest" } })
  })

  it("refuses a package.json that is not an object", async () => {
    const bytes = await tarball({ "package.json": "[]" })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toMatchObject({ ok: false, error: { kind: "manifest" } })
  })

  it("refuses bytes that are not gzip", async () => {
    const bytes = new TextEncoder().encode("not a tarball")
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toMatchObject({ ok: false, error: { kind: "gzip" } })
  })

  it("ignores symlink entries", async () => {
    const bytes = await gzip(
      ustar([
        { path: "package/package.json", data: manifest({ bundle: [] }) },
        { path: "package/link.md", data: "../../secret.md", type: "2" },
      ]),
    )
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.read("link.md")).toBeUndefined()
  })

  it("refuses a tarball that repeats a path", async () => {
    const bytes = await gzip(
      ustar([
        { path: "package/package.json", data: manifest({ bundle: [] }) },
        { path: "package/dup.md", data: "one" },
        { path: "package/dup.md", data: "two" },
      ]),
    )
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toMatchObject({ ok: false, error: { kind: "archive" } })
  })
})

const respond =
  (response: Response): typeof fetch =>
  async () =>
    response

describe("fetchTarball", () => {
  it("reads a body under the cap", async () => {
    const found = await fetchTarball(respond(new Response(new Uint8Array([1, 2, 3]))), "https://registry.test/x.tgz")
    expect(found).toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) })
  })

  it("refuses a redirect instead of following it", async () => {
    const response = new Response(null, { status: 302, headers: { location: "https://evil.test/x.tgz" } })
    const found = await fetchTarball(respond(response), "https://registry.test/x.tgz")
    expect(found).toMatchObject({ ok: false, error: { kind: "redirect" } })
  })

  it("refuses a streamed body larger than the cap", async () => {
    const found = await fetchTarball(respond(new Response(new Uint8Array(64))), "https://registry.test/x.tgz", {
      cap: 32,
    })
    expect(found).toMatchObject({ ok: false, error: { kind: "size" } })
  })

  it("refuses an oversized content-length before reading the body", async () => {
    const response = new Response(new Uint8Array(4), { headers: { "content-length": "4096" } })
    const found = await fetchTarball(respond(response), "https://registry.test/x.tgz", { cap: 32 })
    expect(found).toMatchObject({ ok: false, error: { kind: "size" } })
  })
})

const row = (config: JsonValue): BundleRow => ({ id: "skill", plugin: "skill", config })

const reader =
  (files: Readonly<Record<string, string>>) =>
  (path: string): string | undefined =>
    files[path]

describe("inlineFiles", () => {
  it("replaces a $file reference at any depth", () => {
    const rows = [
      row({ markdown: { $file: "skills/research.md" } }),
      row({ list: [{ title: "one", body: { $file: "skills/one.md" } }] }),
    ]
    const found = inlineFiles(rows, reader({ "skills/research.md": "# Research", "skills/one.md": "# One" }))
    expect(found).toEqual({
      ok: true,
      value: [
        { id: "skill", plugin: "skill", config: { markdown: "# Research" } },
        { id: "skill", plugin: "skill", config: { list: [{ title: "one", body: "# One" }] } },
      ],
    })
  })

  it("leaves objects that are not exactly a $file reference", () => {
    const rows = [row({ a: { $file: "x.md", extra: true }, b: { $file: 3 } })]
    const found = inlineFiles(rows, reader({ "x.md": "x" }))
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value[0]?.config).toEqual({ a: { $file: "x.md", extra: true }, b: { $file: 3 } })
  })

  it("leaves rows without a config untouched", () => {
    const rows: readonly BundleRow[] = [{ id: "prompt", plugin: "prompt", disabled: true }]
    expect(inlineFiles(rows, reader({}))).toEqual({ ok: true, value: rows })
  })

  it("refuses a missing file", () => {
    const found = inlineFiles([row({ markdown: { $file: "missing.md" } })], reader({}))
    expect(found).toMatchObject({ ok: false, error: { kind: "file" } })
  })

  it("refuses parent and absolute paths", () => {
    for (const path of ["../secret.md", "/etc/passwd", "skills\\..\\secret.md"]) {
      const found = inlineFiles([row({ markdown: { $file: path } })], reader({ [path]: "secret" }))
      expect(found).toMatchObject({ ok: false, error: { kind: "file" } })
    }
  })

  it("refuses a file larger than 64 KiB", () => {
    const text = "x".repeat(MAX_FILE_BYTES + 1)
    const found = inlineFiles([row({ markdown: { $file: "big.md" } })], reader({ "big.md": text }))
    expect(found).toMatchObject({ ok: false, error: { kind: "size" } })
  })

  it("accepts a file of exactly 64 KiB", () => {
    const text = "x".repeat(MAX_FILE_BYTES)
    const found = inlineFiles([row({ markdown: { $file: "big.md" } })], reader({ "big.md": text }))
    expect(found.ok).toBe(true)
  })
})

describe("tarballAllowed", () => {
  it("allows https on the registry host", () => {
    expect(tarballAllowed("https://registry.npmjs.org/demo/-/demo-1.0.0.tgz", "https://registry.npmjs.org")).toBe(true)
  })

  it("refuses another host", () => {
    expect(tarballAllowed("https://evil.example.com/demo.tgz", "https://registry.npmjs.org")).toBe(false)
  })

  it("refuses plain http", () => {
    expect(tarballAllowed("http://registry.npmjs.org/demo.tgz", "https://registry.npmjs.org")).toBe(false)
  })

  it("refuses an invalid url", () => {
    expect(tarballAllowed("not a url", "https://registry.npmjs.org")).toBe(false)
  })
})
