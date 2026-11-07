import { describe, expect, it } from "vitest"
import { ABBREVIATED_ACCEPT, registry } from "./registry.ts"

type Call = {
  readonly input: string
  readonly url: URL
  readonly accept: string | undefined
}

const BASE = "https://registry.npmjs.org"

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

function serve(handler: (url: URL) => Response | Promise<Response>): {
  readonly fetch: typeof fetch
  readonly calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, BASE)
    calls.push({ input: raw, url, accept: new Headers(init?.headers).get("accept") ?? undefined })
    return handler(url)
  }
  return { fetch: fetchImpl, calls }
}

const DIST = { tarball: `${BASE}/demo/-/demo-1.0.0.tgz`, integrity: "sha512-AAAA" }

const refused: typeof fetch = async () => {
  throw new TypeError("connection refused")
}

const silent: typeof fetch = () => new Promise<Response>(() => {})

const hanging = (): Promise<Response> => Promise.resolve(new Response(new ReadableStream({ start() {} })))

describe("registry abbreviated document", () => {
  it("reads dist-tags, versions, deprecation, engines and time", async () => {
    const { fetch, calls } = serve(() =>
      json({
        name: "demo",
        "dist-tags": { latest: "1.1.0" },
        versions: {
          "1.0.0": { dist: DIST, engines: { xin: ">=0.1.0", node: ">=20" } },
          "1.1.0": { dist: DIST, deprecated: "use 2.0.0" },
        },
        time: { created: "2026-01-01T00:00:00.000Z", "1.0.0": "2026-01-02T00:00:00.000Z" },
        "unknown-field": { anything: true },
      }),
    )
    const found = await registry({ fetch, baseUrl: BASE }).abbreviated("demo")
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.name).toBe("demo")
    expect(found.value.distTags).toEqual({ latest: "1.1.0" })
    expect(found.value.versions).toHaveLength(2)
    expect(found.value.versions[0]).toEqual({ version: "1.0.0", engines: { xin: ">=0.1.0" }, dist: DIST })
    expect(found.value.versions[1]?.deprecated).toBe("use 2.0.0")
    expect(found.value.time?.created).toBe("2026-01-01T00:00:00.000Z")
    expect(calls[0]?.accept).toBe(ABBREVIATED_ACCEPT)
    expect(calls[0]?.url.pathname).toBe("/demo")
  })

  it("encodes a scoped name the npm way", async () => {
    const { fetch, calls } = serve(() => json({ name: "@acme/xin-plugin", versions: {} }))
    await registry({ fetch, baseUrl: BASE }).abbreviated("@acme/xin-plugin")
    expect(calls[0]?.input).toBe(`${BASE}/@acme%2fxin-plugin`)
  })

  it("returns a typed failure on a malformed document", async () => {
    const { fetch } = serve(() => json({ name: "demo", versions: { "1.0.0": { deprecated: "x" } } }))
    const found = await registry({ fetch, baseUrl: BASE }).abbreviated("demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "parse" } })
  })
})

describe("registry version document", () => {
  it("reads the xin field, readme and dist", async () => {
    const { fetch, calls } = serve(() =>
      json({
        name: "demo",
        version: "1.0.0",
        xin: { bundle: [{ id: "prompt", plugin: "prompt" }] },
        readme: "# demo",
        dist: { ...DIST, shasum: "ignored" },
        scripts: { install: "ignored" },
      }),
    )
    const found = await registry({ fetch, baseUrl: BASE }).version("demo", "1.0.0")
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.xin).toEqual({ bundle: [{ id: "prompt", plugin: "prompt" }] })
    expect(found.value.readme).toBe("# demo")
    expect(found.value.dist).toEqual(DIST)
    expect(calls[0]?.url.pathname).toBe("/demo/1.0.0")
    expect(calls[0]?.accept).toBe("application/json")
  })

  it("accepts a dist-tag as the version", async () => {
    const { fetch, calls } = serve(() => json({ name: "demo", version: "1.0.0", dist: DIST }))
    const found = await registry({ fetch, baseUrl: BASE }).version("demo", "latest")
    expect(found.ok).toBe(true)
    expect(calls[0]?.url.pathname).toBe("/demo/latest")
  })

  it("rejects a malformed version without a request", async () => {
    const { fetch, calls } = serve(() => json({}))
    const found = await registry({ fetch, baseUrl: BASE }).version("demo", "../../etc")
    expect(found).toMatchObject({ ok: false, error: { kind: "input" } })
    expect(calls).toHaveLength(0)
  })
})

describe("registry search", () => {
  it("searches the xin-plugin keyword and returns plain hits", async () => {
    const { fetch, calls } = serve(() =>
      json({
        objects: [
          {
            package: { name: "demo", version: "1.2.0", description: "Demo plugin", keywords: ["xin-plugin"] },
            score: 1,
          },
          { package: { name: "other" }, flags: {} },
        ],
        total: 2,
      }),
    )
    const found = await registry({ fetch, baseUrl: BASE }).search("research")
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value).toEqual([{ name: "demo", description: "Demo plugin" }, { name: "other" }])
    expect(calls[0]?.url.pathname).toBe("/-/v1/search")
    expect(calls[0]?.url.searchParams.get("text")).toBe("keywords:xin-plugin research")
  })

  it("searches the bare keyword without a query", async () => {
    const { fetch, calls } = serve(() => json({ objects: [] }))
    const found = await registry({ fetch, baseUrl: BASE }).search("  ")
    expect(found.ok).toBe(true)
    expect(calls[0]?.url.searchParams.get("text")).toBe("keywords:xin-plugin")
  })
})

describe("registry index", () => {
  it("reads the dsh index shape and drops unknown fields", async () => {
    const { fetch } = serve(() =>
      json({
        format: 1,
        generated: "ignored",
        packages: [
          {
            name: "@acme/xin-plugin",
            title: "Acme",
            description: "Acme tools",
            icon: "https://example.com/icon.png",
            author: "Acme",
            repository: "https://github.com/acme/xin-plugin",
            metadata: { categories: ["tools"], labels: ["search"], stars: 3 },
            extra: true,
          },
        ],
      }),
    )
    const found = await registry({ fetch, baseUrl: BASE }).index("https://example.com/index.json")
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value).toEqual([
      {
        name: "@acme/xin-plugin",
        title: "Acme",
        description: "Acme tools",
        icon: "https://example.com/icon.png",
        author: "Acme",
        repository: "https://github.com/acme/xin-plugin",
        metadata: { categories: ["tools"], labels: ["search"] },
      },
    ])
  })

  it("rejects another index format", async () => {
    const { fetch } = serve(() => json({ format: 2, packages: [] }))
    const found = await registry({ fetch, baseUrl: BASE }).index("https://example.com/index.json")
    expect(found).toMatchObject({ ok: false, error: { kind: "parse" } })
  })

  it("rejects an invalid index url without a request", async () => {
    const { fetch, calls } = serve(() => json({ format: 1, packages: [] }))
    const found = await registry({ fetch, baseUrl: BASE }).index("not a url")
    expect(found).toMatchObject({ ok: false, error: { kind: "input" } })
    expect(calls).toHaveLength(0)
  })

  it("rejects a plain http index url without a request", async () => {
    const { fetch, calls } = serve(() => json({ format: 1, packages: [] }))
    const found = await registry({ fetch, baseUrl: BASE }).index("http://example.com/index.json")
    expect(found).toMatchObject({ ok: false, error: { kind: "input" } })
    expect(calls).toHaveLength(0)
  })
})

describe("registry failures", () => {
  it("reports an http status", async () => {
    const { fetch } = serve(() => new Response("gone", { status: 404 }))
    const found = await registry({ fetch, baseUrl: BASE }).abbreviated("demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "http", status: 404 } })
  })

  it("reports a transport error", async () => {
    const found = await registry({ fetch: refused, baseUrl: BASE }).abbreviated("demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "network" } })
  })

  it("reports invalid json", async () => {
    const { fetch } = serve(() => new Response("{", { status: 200 }))
    const found = await registry({ fetch, baseUrl: BASE }).abbreviated("demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "parse" } })
  })

  it("times out a transport that never answers", async () => {
    const found = await registry({ fetch: silent, baseUrl: BASE, timeoutMs: 5 }).abbreviated("demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "timeout" } })
  })

  it("classifies an aborted body read as a timeout", async () => {
    const found = await registry({ fetch: hanging, baseUrl: BASE, timeoutMs: 5 }).abbreviated("demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "timeout" } })
  })

  it("rejects an invalid package name without a request", async () => {
    const { fetch, calls } = serve(() => json({}))
    const found = await registry({ fetch, baseUrl: BASE }).abbreviated("../demo")
    expect(found).toMatchObject({ ok: false, error: { kind: "input" } })
    expect(calls).toHaveLength(0)
  })
})
