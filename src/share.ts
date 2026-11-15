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
    etag: object.httpEtag,
  })

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
    return object === null
      ? new Response(null, { status: 404 })
      : new Response(null, { headers: served(manifest, object) })
  }
  const object = await env.FILES.get(manifest.key)
  if (object === null) return new Response("not found", { status: 404 })
  return new Response(object.body, { headers: served(manifest, object) })
}
