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

/** A token minted by `session.rotate` is checked by the home that minted it, so a rotation takes effect at once. */
async function authorizedByRotation(request: Request, env: Env): Promise<boolean> {
  const presented = bearer(request)
  if (presented === undefined) return false
  try {
    const reply = await home(env).fetch("https://xin.internal/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: presented }),
    })
    return reply.ok
  } catch {
    return false
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
    if (!authorizedByDeploy(request, env) && !(await authorizedByRotation(request, env)))
      return new Response("unauthorized", { status: 401 })
    const uploaded = await upload(request, env)
    if (uploaded !== undefined) return uploaded
    const forwarded = new Request(request)
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim())
    if (protocols.includes("xin")) forwarded.headers.set("x-xin-protocol", "xin")
    return home(env).fetch(forwarded)
  },
} satisfies ExportedHandler<Env>
