import type { Env } from "./env.ts"

export { Home } from "./host.ts"
import { bearer, sameToken } from "./kernel/token.ts"
import { serveShare } from "./share.ts"
import { upload } from "./upload.ts"

const home = (env: Env) => env.HOME.get(env.HOME.idFromName("owner"))

/**
 * An upload writes to R2 before the home sees it, so it is the one path the Worker authorizes itself: the deploy token
 * here, a rotated token by asking the home. A home that cannot boot answers 503, and that reply is passed through.
 */
async function uploadRefusal(request: Request, env: Env, presented: string): Promise<Response | undefined> {
  if (env.OWNER_TOKEN !== "" && sameToken(presented, env.OWNER_TOKEN)) return undefined
  const reply = await home(env).fetch("https://ingle.internal/v1/auth", {
    method: "POST",
    headers: { authorization: `Bearer ${presented}` },
  })
  return reply.ok ? undefined : reply
}

const isUpload = (request: Request, url: URL) => request.method === "PUT" && url.pathname.startsWith("/files/")

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    const shared = await serveShare(request, env)
    if (shared !== undefined) return shared
    const presented = bearer(request)
    if (presented === undefined || presented === "") return new Response("unauthorized", { status: 401 })
    if (isUpload(request, url)) {
      const refused = await uploadRefusal(request, env, presented)
      if (refused !== undefined) return refused
      return (await upload(request, env, presented)) ?? new Response("not found", { status: 404 })
    }
    const forwarded = new Request(request)
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim())
    if (protocols.includes("ingle")) forwarded.headers.set("x-ingle-protocol", "ingle")
    return home(env).fetch(forwarded)
  },
} satisfies ExportedHandler<Env>
