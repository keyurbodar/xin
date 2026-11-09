import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import { compile, int, obj, opt, str } from "@earendil-works/pi-schema"
import type { JobsService } from "../../src/contracts/jobs.ts"
import { messageOf } from "../../src/errors.ts"
import { textResult } from "../../src/kernel/index.ts"

const SEARCH_URL = "https://html.duckduckgo.com/html/"
const USER_AGENT = "Mozilla/5.0 (compatible; Xin/0.1; +https://github.com/keyurbodar/xin)"
const TIMEOUT_MS = 15_000
const SEARCH_BYTES = 1_000_000
const PAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_RESULTS = 5
const DEFAULT_FETCH_CHARS = 20_000
const MAX_FETCH_CHARS = 100_000
const MAX_URL = 2_048

export type SearchResult = {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export type FetchedPage = {
  readonly url: string
  readonly title: string
  readonly contentType: string
  readonly text: string | null
  readonly truncated: boolean
}

const SearchArgs = obj({
  query: str({ minLength: 1, maxLength: 500, description: "What to search for." }),
  maxResults: opt(
    int({ minimum: 1, maximum: 10, description: `How many results to return, ${DEFAULT_RESULTS} by default.` }),
  ),
})

const FetchArgs = obj({
  url: str({ minLength: 1, maxLength: MAX_URL, description: "An http or https URL on the public web." }),
  maxChars: opt(
    int({
      minimum: 1_000,
      maximum: MAX_FETCH_CHARS,
      description: `How many characters of readable text to return, ${DEFAULT_FETCH_CHARS} by default.`,
    }),
  ),
})

const searchCheck = compile(SearchArgs)
const fetchCheck = compile(FetchArgs)

const named: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  lt: "<",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  quot: '"',
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1]?.toLowerCase() === "x"
      const digits = hex ? body.slice(2) : body.slice(1)
      const value = Number.parseInt(digits, hex ? 16 : 10)
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole
    }
    return named[body.toLowerCase()] ?? whole
  })
}

function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function stripTags(value: string): string {
  return cleanText(value)
}

function decodeResultUrl(raw: string): string | undefined {
  const absolute = raw.startsWith("//") ? `https:${raw}` : raw.startsWith("/") ? `https://duckduckgo.com${raw}` : raw
  let url: URL
  try {
    url = new URL(absolute)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
    if (url.pathname !== "/l/") return undefined
    const target = url.searchParams.get("uddg")
    if (target === null) return undefined
    try {
      const decoded = new URL(target)
      return decoded.protocol === "http:" || decoded.protocol === "https:" ? decoded.toString() : undefined
    } catch {
      return undefined
    }
  }
  return url.toString()
}

export function parseSearchResults(html: string, limit = DEFAULT_RESULTS): SearchResult[] {
  const anchors = [
    ...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  ]
  const snippets = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
  const fallbackAnchors = [
    ...html.matchAll(/<a\b[^>]*class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  ]
  const fallbackSnippets = [
    ...html.matchAll(/<(?:td|div)\b[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div)>/gi),
  ]
  const found = anchors.length > 0 ? anchors : fallbackAnchors
  const text = anchors.length > 0 ? snippets : fallbackSnippets
  const results: SearchResult[] = []
  for (const [index, match] of found.entries()) {
    const rawUrl = match[1]
    const rawTitle = match[2]
    if (rawUrl === undefined || rawTitle === undefined) continue
    const url = decodeResultUrl(rawUrl)
    if (url === undefined) continue
    const title = stripTags(rawTitle)
    if (title === "") continue
    const rawSnippet = text[index]?.[1] ?? ""
    const snippet = stripTags(rawSnippet)
    results.push({ title, url, snippet })
    if (results.length >= limit) break
  }
  return results
}

export function extractHtml(html: string): { readonly title: string; readonly text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch?.[1] === undefined ? "" : stripTags(titleMatch[1])
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  const text = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { title, text }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === undefined || b === undefined) return false
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").some((part) => part.length > 1 && part.startsWith("0")))
    return true
  if (isPrivateIpv4(host)) return true
  if (!host.includes(":")) return false
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80") ||
    host.startsWith("::ffff:")
  )
}

export function publicUrl(raw: string): URL {
  if (raw.length > MAX_URL) throw new Error("the URL is too long")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("that is not a valid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are supported")
  if (url.port !== "" && url.port !== "80" && url.port !== "443")
    throw new Error("only the default HTTP and HTTPS ports are supported")
  if (url.username !== "" || url.password !== "") throw new Error("URLs with credentials are not supported")
  if (isPrivateHost(url.hostname)) throw new Error("only public web hosts are supported")
  return url
}

function timeoutSignal(signal: AbortSignal): { readonly signal: AbortSignal; readonly done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("the request timed out")), TIMEOUT_MS)
  const abort = (): void => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    },
  }
}

type Read = { readonly bytes: Uint8Array; readonly truncated: boolean }

async function readCapped(response: Response, cap: number): Promise<Read> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > cap ? { bytes: bytes.subarray(0, cap), truncated: true } : { bytes, truncated: false }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - total))
      total = cap
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1]
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

async function request(url: string, signal: AbortSignal, accept: string): Promise<Response> {
  const timed = timeoutSignal(signal)
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept },
      redirect: "follow",
      signal: timed.signal,
    })
    if (!response.ok) throw new Error(`the server answered ${response.status}`)
    publicUrl(response.url === "" ? url : response.url)
    return response
  } finally {
    timed.done()
  }
}

export async function searchWeb(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(SEARCH_URL)
  url.searchParams.set("q", query)
  url.searchParams.set("kl", "wt-wt")
  const response = await request(url.toString(), signal, "text/html")
  const body = await readCapped(response, SEARCH_BYTES)
  const results = parseSearchResults(decode(body.bytes, response.headers.get("content-type") ?? ""), maxResults)
  if (results.length === 0) throw new Error("the search returned no results")
  return results
}

export async function fetchPage(raw: string, maxChars: number, signal: AbortSignal): Promise<FetchedPage> {
  const url = publicUrl(raw)
  const response = await request(
    url.toString(),
    signal,
    "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
  )
  const contentType = response.headers.get("content-type") ?? ""
  const body = await readCapped(response, PAGE_BYTES)
  const rawText = decode(body.bytes, contentType)
  const isHtml = /html/i.test(contentType) || (contentType === "" && /<html|<body|<p\b/i.test(rawText))
  if (isHtml) {
    const page = extractHtml(rawText)
    const text = page.text.length > maxChars ? `${page.text.slice(0, maxChars)}…` : page.text
    return {
      url: url.toString(),
      title: page.title,
      contentType,
      text,
      truncated: body.truncated || text.length < page.text.length,
    }
  }
  if (/^text\/|json|xml/i.test(contentType) || contentType === "") {
    const text = rawText.length > maxChars ? `${rawText.slice(0, maxChars)}…` : rawText
    return {
      url: url.toString(),
      title: "",
      contentType,
      text,
      truncated: body.truncated || text.length < rawText.length,
    }
  }
  return {
    url: url.toString(),
    title: "",
    contentType,
    text: null,
    truncated: body.truncated,
  }
}

function searchText(query: string, results: readonly SearchResult[]): string {
  return [
    `Search results for "${query}":`,
    ...results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`),
  ].join("\n\n")
}

function fetchText(page: FetchedPage): string {
  const header = [
    `Fetched ${page.url}`,
    `Title: ${page.title === "" ? "(none)" : page.title}`,
    `Type: ${page.contentType || "(unknown)"}`,
  ]
  if (page.text === null) return [...header, "", "The response is not text; only its metadata is returned."].join("\n")
  return [...header, "", page.text].join("\n")
}

function failure(action: string, error: unknown): ToolExecutionResult {
  return textResult(`${action}: ${messageOf(error)}`, { isError: true })
}

export function createTools(jobs: JobsService): readonly ToolRegistration[] {
  const search = jobs.tool(
    {
      name: "web_search",
      description: "Search the public web. Returns result titles, URLs and snippets. Use web_fetch to read a result.",
      parameters: SearchArgs,
    },
    async (args, run) => {
      if (!searchCheck.check(args)) return textResult("web_search needs a query", { isError: true })
      try {
        const results = await searchWeb(args.query, args.maxResults ?? DEFAULT_RESULTS, run.signal)
        return textResult(searchText(args.query, results), {
          details: { query: args.query, results: results.map((result) => ({ ...result })) },
        })
      } catch (error) {
        return failure("web_search failed", error)
      }
    },
  )

  const fetchTool = jobs.tool(
    {
      name: "web_fetch",
      description:
        "Fetch a public http or https page and return its readable text. HTML is reduced to text; non-text responses return metadata only.",
      parameters: FetchArgs,
    },
    async (args, run) => {
      if (!fetchCheck.check(args)) return textResult("web_fetch needs a URL", { isError: true })
      try {
        const page = await fetchPage(args.url, args.maxChars ?? DEFAULT_FETCH_CHARS, run.signal)
        return textResult(fetchText(page), {
          details: {
            url: page.url,
            title: page.title,
            contentType: page.contentType,
            truncated: page.truncated,
          },
        })
      } catch (error) {
        return failure("web_fetch failed", error)
      }
    },
  )

  return [search, fetchTool]
}
