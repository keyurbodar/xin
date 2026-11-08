import { describe, expect, it } from "vitest"
import { extractBundle, fetchTarball } from "./tarball.ts"
import { gzip, integrityOf, tarball, ustar } from "../../test/plugins/market.ts"

const manifest = (xin: unknown): string => JSON.stringify({ name: "demo", version: "1.0.0", xin })

describe("extractBundle", () => {
  it("reads the xin field of package/package.json and nothing else", async () => {
    const xin = { bundle: [{ id: "clock", plugin: "time", config: { timezone: "UTC" } }] }
    const bytes = await tarball({
      "package.json": manifest(xin),
      "skills/research.md": "# Research",
    })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toEqual({ ok: true, value: { xin } })
  })

  it("ignores directories, other packages and entries outside package/", async () => {
    const bytes = await gzip(
      ustar([
        { path: "package/", data: "", type: "5" },
        { path: "other/package.json", data: manifest({ bundle: ["evil"] }) },
        { path: "package/../package.json", data: manifest({ bundle: ["evil"] }) },
        { path: "package/package.json", data: manifest({ bundle: [] }) },
      ]),
    )
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toEqual({ ok: true, value: { xin: { bundle: [] } } })
  })

  it("ignores symlink entries", async () => {
    const bytes = await gzip(
      ustar([
        { path: "package/package.json", data: manifest({ bundle: [] }), type: "0" },
        { path: "package/link.json", data: "../../secret.json", type: "2" },
      ]),
    )
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toEqual({ ok: true, value: { xin: { bundle: [] } } })
  })

  it("accepts a package.json without a xin field", async () => {
    const bytes = await tarball({ "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }) })
    const found = await extractBundle({ bytes, integrity: await integrityOf(bytes) })
    expect(found).toEqual({ ok: true, value: { xin: undefined } })
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

  it("refuses a tarball that repeats package.json", async () => {
    const bytes = await gzip(
      ustar([
        { path: "package/package.json", data: manifest({ bundle: [] }) },
        { path: "package/package.json", data: manifest({ bundle: ["one"] }) },
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

  it("refuses a url that is not https", async () => {
    const found = await fetchTarball(respond(new Response(new Uint8Array([1]))), "http://registry.test/x.tgz")
    expect(found).toMatchObject({ ok: false, error: { kind: "input" } })
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
