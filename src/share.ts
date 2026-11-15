import { compile, obj, type Static, str } from "@earendil-works/pi-schema"
import type { Env } from "./env.ts"

const SHARE_PATH = /^\/s\/([0-9a-f]{32})(?:\/[^/]*)?$/

/** What a share link points at, kept in R2 beside the blobs so serving it never wakes the home. */
const ShareManifestSchema = obj({
  key: str({ minLength: 1 }),
  type: str({ minLength: 1 }),
  name: str({ minLength: 1 }),
})
const parseManifest = compile(ShareManifestSchema)

type Manifest = Static<typeof ShareManifestSchema>

const served = (manifest: Manifest, object: R2Object): Headers =>
  new Headers({
    "content-type": manifest.type,
    "content-length": String(object.size),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(manifest.name)}`,
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=60",
    "accept-ranges": "bytes",
    "last-modified": object.uploaded.toUTCString(),
    etag: object.httpEtag,
  })

/** The bytes R2 served for a ranged read, as an inclusive span of the whole object. */
function spanOf(range: R2Range, size: number): { readonly start: number; readonly end: number } {
  if ("suffix" in range && range.suffix !== undefined) return { start: Math.max(0, size - range.suffix), end: size - 1 }
  const start = "offset" in range ? (range.offset ?? 0) : 0
  const asked = "length" in range ? range.length : undefined
  return { start, end: start + Math.min(asked ?? size - start, size - start) - 1 }
}

const notModified = (headers: Headers): Response => {
  headers.delete("content-length")
  return new Response(null, { status: 304, headers })
}

const tags = (value: string): string[] => value.split(",").map((tag) => tag.trim())

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000)

/** Whether an HTTP date header holds at or after the object's last write, to the second. */
const notChangedSince = (value: string, object: R2Object): boolean => {
  const at = Date.parse(value)
  return !Number.isNaN(at) && seconds(object.uploaded) <= Math.floor(at / 1000)
}

const matches = (request: Request, object: R2Object): boolean =>
  tags(request.headers.get("if-none-match") ?? "").some(
    (tag) => tag === "*" || tag.replace(/^W\//, "") === object.httpEtag,
  )

/** A failed `If-Match`, or `If-Unmodified-Since` without one, means the client's copy is stale: 412, not 304. */
function preconditionFailed(request: Request, object: R2Object): boolean {
  const ifMatch = request.headers.get("if-match")
  if (ifMatch !== null) return !tags(ifMatch).some((tag) => tag === "*" || tag === object.httpEtag)
  const ifUnmodified = request.headers.get("if-unmodified-since")
  return ifUnmodified !== null && !notChangedSince(ifUnmodified, object)
}

/** `If-Range` keeps a range only while the client's copy is current: a strong ETag match or an unchanged date. */
function rangeHolds(value: string, object: R2Object): boolean {
  const tag = value.trim()
  if (tag.startsWith('"') || tag.startsWith("W/")) return tag === object.httpEtag
  return notChangedSince(tag, object)
}

export const shareKey = (id: string): string => `s/${id}`

/**
 * Serves `GET /s/<id>[/<name>]` from R2 with no auth: the id is the capability. The body is sandboxed so an HTML or
 * SVG file cannot run script against the app's origin.
 */
export async function serveShare(request: Request, env: Env): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const id = SHARE_PATH.exec(new URL(request.url).pathname)?.[1]
  if (id === undefined) return undefined
  const stored = await env.FILES.get(shareKey(id))
  const manifest: unknown = stored === null ? undefined : await stored.json().catch(() => undefined)
  if (!parseManifest.check(manifest)) return new Response("not found", { status: 404 })
  if (request.method === "HEAD") {
    const object = await env.FILES.head(manifest.key)
    if (object === null) return new Response(null, { status: 404 })
    const headers = served(manifest, object)
    if (preconditionFailed(request, object)) {
      headers.delete("content-length")
      return new Response(null, { status: 412, headers })
    }
    return matches(request, object) ? notModified(headers) : new Response(null, { headers })
  }
  const ifRange = request.headers.get("if-range")
  let ranged = request.headers.has("range")
  if (ranged && ifRange !== null) {
    const current = await env.FILES.head(manifest.key)
    if (current === null) return new Response("not found", { status: 404 })
    ranged = rangeHolds(ifRange, current)
  }
  let object: R2Object | R2ObjectBody | null
  try {
    object = await env.FILES.get(manifest.key, {
      onlyIf: request.headers,
      ...(ranged ? { range: request.headers } : {}),
    })
  } catch {
    const head = await env.FILES.head(manifest.key)
    if (head === null) return new Response("not found", { status: 404 })
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } })
  }
  if (object === null) return new Response("not found", { status: 404 })
  const headers = served(manifest, object)
  if (!("body" in object)) {
    if (!preconditionFailed(request, object)) return notModified(headers)
    headers.delete("content-length")
    return new Response(null, { status: 412, headers })
  }
  if (!ranged || object.range === undefined) return new Response(object.body, { headers })
  const asked = /^bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1]
  const { start, end } = spanOf(object.range, object.size)
  if (start > end || (asked !== undefined && Number(asked) >= object.size))
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${object.size}` } })
  headers.set("content-range", `bytes ${start}-${end}/${object.size}`)
  headers.set("content-length", String(end - start + 1))
  return new Response(object.body, { status: 206, headers })
}
