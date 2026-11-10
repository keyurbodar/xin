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

function authorizedByDeploy(request: Request, env: Env): boolean {
  const presented = bearer(request)
  if (presented === undefined || env.OWNER_TOKEN === "") return false
  return sameToken(presented, env.OWNER_TOKEN)
}

/**
 * A token minted by `session.rotate` is checked by the home that minted it, so a rotation takes effect at once.
 * Returns the home's reply so its failure mode survives: a home that cannot boot answers 503, not a 401.
 */
async function rotationCheck(request: Request, env: Env): Promise<Response | undefined> {
  const presented = bearer(request)
  if (presented === undefined) return undefined
  try {
    return await home(env).fetch("https://xin.internal/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: presented }),
    })
  } catch {
    return undefined
  }
}

function sameToken(a: string, b: string): boolean {
  const [left, right] = [encoder.encode(a), encoder.encode(b)]
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right)
}

const home = (env: Env) => env.HOME.get(env.HOME.idFromName("owner"))

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname === "/health") return new Response("ok")
    if (!authorizedByDeploy(request, env)) {
      const reply = await rotationCheck(request, env)
      // A home that cannot boot answers 503 for every path: pass that through, so a rotated-token client is told the
      // home failed to open instead of being sent an auth error it cannot act on.
      if (reply !== undefined && !reply.ok && reply.status !== 401) return reply
      if (reply === undefined || !reply.ok) return new Response("unauthorized", { status: 401 })
    }
    const uploaded = await upload(request, env)
    if (uploaded !== undefined) return uploaded
    const forwarded = new Request(request)
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim())
    if (protocols.includes("xin")) forwarded.headers.set("x-xin-protocol", "xin")
    return home(env).fetch(forwarded)
  },
} satisfies ExportedHandler<Env>
