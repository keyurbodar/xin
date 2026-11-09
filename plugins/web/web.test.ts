import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { extractHtml, parseSearchResults, publicUrl } from "./web.ts"

const SEARCH_HTML = `<div class="result results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Page</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">A <b>short</b> snippet &amp; more</a>
</div>
<div class="result">
  <h2><a class="result__a" href="https://second.example/x">Second result</a></h2>
  <a class="result__snippet">Another snippet</a>
</div>`

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

const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith("https://html.duckduckgo.com/html/"))
    return new Response(SEARCH_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
  if (url === "https://example.com/page")
    return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
  return new Response("not found", { status: 404 })
}) as typeof fetch

describe("web parsing", () => {
  it("reads DuckDuckGo anchors, snippets and redirect URLs", () => {
    expect(parseSearchResults(SEARCH_HTML, 5)).toEqual([
      { title: "Example Page", url: "https://example.com/page", snippet: "A short snippet & more" },
      { title: "Second result", url: "https://second.example/x", snippet: "Another snippet" },
    ])
    expect(parseSearchResults(SEARCH_HTML, 1)).toHaveLength(1)
  })

  it("reduces an HTML page to a title and readable text", () => {
    expect(extractHtml(PAGE_HTML)).toEqual({ title: "Hello & world", text: "Hello\n\nOne & two\n\nSecond line" })
  })

  it("refuses private, loopback and non-http URLs", () => {
    for (const url of [
      "http://localhost/",
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

describe("web tools", () => {
  it("searches and fetches through the model-facing tools", async () => {
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const stub = fresh()
      respond([
        () => fauxAssistantMessage([fauxToolCall("web_search", { query: "xin" })], { stopReason: "toolUse" }),
        () =>
          fauxAssistantMessage([fauxToolCall("web_fetch", { url: "https://example.com/page" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("done"),
      ])
      await turn(stub, "web-tools", { text: "look it up" })
      const root = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, root))
      expect(texts.some((text) => text.includes("Example Page"))).toBe(true)
      expect(texts.some((text) => text.includes("One & two"))).toBe(true)
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
