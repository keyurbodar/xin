import type { Env } from "./env.ts"

export { Home } from "./host.ts"
import { bearer, sameToken } from "./kernel/token.ts"
import { blobKey } from "./r2env.ts"
import { serveShare } from "./share.ts"
import { upload } from "./upload.ts"

const home = (env: Env) => env.HOME.get(env.HOME.idFromName("owner"))

/**
 * An upload writes to R2 before the home sees it, and a blob read never reaches it, so these are the paths the Worker
 * authorizes itself: the deploy token here, a rotated token by asking the home. A home that cannot boot answers 503, and that reply is passed through.
 */
async function workerRefusal(request: Request, env: Env, presented: string): Promise<Response | undefined> {
  if (env.OWNER_TOKEN !== "" && sameToken(presented, env.OWNER_TOKEN)) return undefined
  const reply = await home(env).fetch("https://ingle.internal/v1/auth", {
    method: "POST",
    headers: { authorization: `Bearer ${presented}` },
  })
  return reply.ok ? undefined : reply
}

const isUpload = (request: Request, url: URL) => request.method === "PUT" && url.pathname.startsWith("/files/")

const BLOB_PATH = /^\/blobs\/([0-9a-f]{64})$/

/** A stored message's attachment by content address, straight from R2: the bytes never change, so they cache forever. */
async function serveBlob(env: Env, sha256: string): Promise<Response> {
  const object = await env.FILES.get(blobKey(sha256))
  if (object === null) return new Response("not found", { status: 404 })
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    const shared = await serveShare(request, env)
    if (shared !== undefined) return shared
    if (url.pathname.startsWith("/hooks/")) return home(env).fetch(request)
    const presented = bearer(request)
    if (presented === undefined || presented === "") return new Response("unauthorized", { status: 401 })
    const blob = request.method === "GET" ? BLOB_PATH.exec(url.pathname)?.[1] : undefined
    if (isUpload(request, url) || blob !== undefined) {
      const refused = await workerRefusal(request, env, presented)
      if (refused !== undefined) return refused
      if (blob !== undefined) return serveBlob(env, blob)
      return (await upload(request, env, presented)) ?? new Response("not found", { status: 404 })
    }
    const forwarded = new Request(request)
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim())
    if (protocols.includes("ingle")) forwarded.headers.set("x-ingle-protocol", "ingle")
    return home(env).fetch(forwarded)
  },
} satisfies ExportedHandler<Env>
