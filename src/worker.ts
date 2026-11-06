import type { Env } from "./env.ts"

export { Home } from "./host.ts"
import { upload } from "./upload.ts"

const encoder = new TextEncoder()

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? ""
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length)
  const protocol = request.headers.get("sec-websocket-protocol") ?? ""
  const token = protocol
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("bearer."))
  return token?.slice("bearer.".length)
}

function authorized(request: Request, env: Env): boolean {
  const presented = bearer(request)
  if (presented === undefined || env.OWNER_TOKEN === "") return false
  const [a, b] = [encoder.encode(presented), encoder.encode(env.OWNER_TOKEN)]
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b)
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return new Response("ok")
    if (!authorized(request, env)) return new Response("unauthorized", { status: 401 })
    const uploaded = await upload(request, env)
    if (uploaded !== undefined) return uploaded
    const forwarded = new Request(request)
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim())
    if (protocols.includes("xin")) forwarded.headers.set("x-xin-protocol", "xin")
    return env.HOME.get(env.HOME.idFromName("owner")).fetch(forwarded)
  },
} satisfies ExportedHandler<Env>
