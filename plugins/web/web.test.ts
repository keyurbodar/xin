import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, loadDeferred, recordOffers, rowOf, type Stub, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { braveResults, extractHtml, publicUrl, SEARCH_KEY_REF } from "./web.ts"

const BRAVE_KEY = "test-brave-key"

const BRAVE_JSON = JSON.stringify({
  type: "search",
  query: { original: "ingle" },
  web: {
    type: "search",
    results: [
      {
        title: "Example <strong>Page</strong>",
        url: "https://example.com/page",
        description: "A <strong>short</strong> snippet &amp; more",
        language: "en",
      },
      { title: "Second result", url: "https://second.example/x", description: "Another snippet" },
    ],
  },
})

type Searched = { readonly url: URL; readonly headers: Headers }

const PAGE_HTML = `<!doctype html>
<html>
  <head>
    <title>Hello &amp; world</title>
    <style>.hidden { display: none }</style>
    <script>alert("not text")</script>
  </head>
  <body>
    <h1>Hello</h1>
    <p>One &amp; two</p>
    <p>Second line</p>
  </body>
</html>`

const LONG_TEXT = "abcdefghij".repeat(2_341)

const long = (args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/long", ...args })], {
    stopReason: "toolUse",
  })
const body = (text: string): string => text.slice(text.indexOf("\n\n") + 2)

const searched: Searched[] = []

const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith("https://api.search.brave.com/res/v1/web/search")) {
    searched.push({ url: new URL(url), headers: new Headers(init?.headers) })
    return new Response(BRAVE_JSON, { headers: { "content-type": "application/json" } })
  }
  if (url === "https://example.com/page")
    return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
  if (url === "https://example.com/long") return new Response(LONG_TEXT, { headers: { "content-type": "text/plain" } })
  return new Response("not found", { status: 404 })
}) as typeof fetch

describe("web parsing", () => {
  it("keeps only http(s) Brave results and caps titles at 300 and snippets at 1,000 characters", () => {
    const results = braveResults(
      {
        web: {
          results: [
            { title: "Script", url: "javascript:alert(1)", description: "dropped" },
            { title: "File", url: "file:///etc/passwd" },
            { title: "Broken", url: "not a url" },
            { title: "x".repeat(400), url: "http://example.com/a", description: `<b>${"y".repeat(1_200)}</b>` },
            { title: "Plain", url: "https://example.com/b" },
          ],
        },
      },
      10,
    )
    expect(results.map((result) => result.url)).toEqual(["http://example.com/a", "https://example.com/b"])
    expect(results[0]?.title).toBe(`${"x".repeat(299)}…`)
    expect(results[0]?.snippet).toBe(`${"y".repeat(999)}…`)
    expect(results[1]).toEqual({ title: "Plain", url: "https://example.com/b", snippet: "" })
    expect(() => braveResults({ web: { results: [{ url: "https://example.com" }] } }, 5)).toThrow()
  })

  it("reduces an HTML page to a title and readable text", () => {
    expect(extractHtml(PAGE_HTML)).toEqual({ title: "Hello & world", text: "Hello\n\nOne & two\n\nSecond line" })
  })

  it("refuses private, loopback and non-http URLs", () => {
    for (const url of [
      "http://localhost/",
      "http://localhost./",
      "http://foo.localhost./",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data",
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://127.0.0.1./",
      "http://example.com:8080/",
      "file:///etc/passwd",
      "http://user:pass@example.com/",
    ])
      expect(() => publicUrl(url), url).toThrow()
    expect(publicUrl("https://example.com/a").toString()).toBe("https://example.com/a")
  })
})

const textOf = (message: { readonly content: unknown }): string => {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .flatMap((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : [],
    )
    .join("")
}

const toolTexts = (home: Home, conversationId: ConversationId): Promise<string[]> =>
  home.harness.conversation(conversationId, BACKGROUND_CONTEXT).then(async (conversation) => {
    if (conversation === undefined) return []
    const page = await conversation.entries({ order: "ascending" }, 300, undefined, BACKGROUND_CONTEXT)
    return page.items.flatMap((entry) =>
      (entry.model ?? [])
        .filter((message) => message.role === "toolResult")
        .map(textOf)
        .filter((text) => text !== ""),
    )
  })

const offered = async (stub: Stub, requestId: string): Promise<readonly string[]> => {
  const offers = recordOffers()
  respond([offers.step()])
  await turn(stub, requestId)
  return offers.latest().available
}

describe("web tools", () => {
  it("ships the web row enabled", async () => {
    expect(await rowOf(fresh(), "tool-web")).toMatchObject({ disabled: false })
  })

  it("offers web_fetch but leaves web_search out until a search key is set", async () => {
    const available = await offered(fresh(), "web-no-key")
    expect(available).toContain("web_fetch")
    expect(available).not.toContain("web_search")
  })

  it("turns web_search on after secret.set and searches Brave with the key", async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    searched.length = 0
    try {
      const stub = fresh()
      expect(await cmd(stub, "web-key", "secret.set", { ref: SEARCH_KEY_REF, value: BRAVE_KEY })).toMatchObject({
        ok: true,
      })
      expect(await offered(stub, "web-keyed")).toEqual(expect.arrayContaining(["web_fetch", "web_search"]))
      await loadDeferred(stub, ["web_search", "web_fetch"])
      respond([
        () =>
          fauxAssistantMessage([fauxToolCall("web_search", { query: "ingle", maxResults: 3 })], {
            stopReason: "toolUse",
          }),
        () =>
          fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/page" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("done"),
      ])
      await turn(stub, "web-tools", { text: "look it up" })
      const root = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, root))
      expect(
        texts.some((text) => text.includes("1. Example Page\nhttps://example.com/page\nA short snippet & more")),
      ).toBe(true)
      expect(texts.some((text) => text.includes("One & two"))).toBe(true)
      expect(searched).toHaveLength(1)
      const [call] = searched
      expect(call?.url.searchParams.get("q")).toBe("ingle")
      expect(call?.url.searchParams.get("count")).toBe("3")
      expect(call?.headers.get("x-subscription-token")).toBe(BRAVE_KEY)
      expect(call?.headers.get("accept")).toBe("application/json")
    } finally {
      globalThis.fetch = original
    }
  }, 20_000)

  it("caps a long page at 8,000 characters and pages the rest with offset", async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const stub = fresh()
      await loadDeferred(stub, ["web_fetch"])
      respond([
        () => long({}),
        () => long({ offset: 8_000 }),
        () => long({ offset: 16_000 }),
        () => long({ offset: 30_000 }),
        () => fauxAssistantMessage("done"),
      ])
      await turn(stub, "web-paging", { text: "read the long page" })
      const root = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, root))
      const [first, second, third, past] = texts.map(body)
      expect(first).toBe(
        `${LONG_TEXT.slice(0, 8_000)}\n\n[Showing characters 0–8000 of 23,410. Call web_fetch again with offset 8000 for more.]`,
      )
      expect(second).toBe(
        `${LONG_TEXT.slice(8_000, 16_000)}\n\n[Showing characters 8000–16000 of 23,410. Call web_fetch again with offset 16000 for more.]`,
      )
      expect(third).toBe(LONG_TEXT.slice(16_000))
      expect(past).toBe("[Offset 30000 is past the end: the page has 23,410 characters.]")
    } finally {
      globalThis.fetch = original
    }
  }, 20_000)

  it("offers the same web tools to a delegated thread", async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const stub = fresh()
      const created = await cmd(stub, "web-thread-project", "project.create", {
        slug: "web-thread",
        name: "Web thread",
      })
      expect(created.ok, JSON.stringify(created)).toBe(true)
      const project = created.result as { id: string }
      const [thread] = await addThreads(stub, project.id, ["web thread"])
      if (thread === undefined) throw new Error("no thread")
      await loadDeferred(stub, ["web_fetch"], thread.id)
      respond([
        () =>
          fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/page" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("done"),
      ])
      await runInDurableObject(stub, async (home: Home) => {
        const conversation = await home.harness.conversation(thread.id, BACKGROUND_CONTEXT)
        if (conversation === undefined) throw new Error("thread conversation disappeared")
        await conversation.submit(
          { type: "input", content: "read the page", requestId: "web-thread-1" },
          BACKGROUND_CONTEXT,
        )
        await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      })
      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
      expect(texts.some((text) => text.includes("One & two"))).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  }, 20_000)
})
