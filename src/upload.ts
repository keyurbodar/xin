import type { Env } from "./env.ts"
import { blobKey, normalizePath, sha256, toHex, typeOf } from "./r2env.ts"

const HASH = "SHA-256"

type Stored = { readonly digest: string; readonly size: number }

function contentLength(request: Request): number | undefined {
  const header = request.headers.get("content-length")
  if (header === null) return undefined
  const length = Number(header)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

async function buffered(env: Env, bytes: Uint8Array): Promise<Stored> {
  const digest = await sha256(bytes)
  await env.FILES.put(blobKey(digest), bytes)
  return { digest, size: bytes.byteLength }
}

async function streamed(env: Env, body: ReadableStream<Uint8Array>, staged: string, length: number): Promise<Stored> {
  const hasher = new crypto.DigestStream(HASH)
  const hashWriter = hasher.getWriter()
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await hashWriter.write(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      await hashWriter.close()
    },
  })
  const { readable, writable } = new FixedLengthStream(length)
  const pump = body.pipeThrough(hashing).pipeTo(writable)
  try {
    await env.FILES.put(staged, readable)
    await pump
  } catch (error) {
    await pump.catch(() => undefined)
    throw error
  }
  const digest = toHex(await hasher.digest)
  await copy(env, staged, blobKey(digest))
  return { digest, size: length }
}

async function copy(env: Env, staged: string, key: string): Promise<void> {
  const object = await env.FILES.get(staged)
  if (object === null) throw new Error("staged bytes are missing")
  const { readable, writable } = new FixedLengthStream(object.size)
  const pump = object.body.pipeTo(writable)
  await env.FILES.put(key, readable)
  await pump
}

export async function upload(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (request.method !== "PUT" || !url.pathname.startsWith("/files/")) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname.slice("/files/".length))
  } catch {
    return Response.json({ error: "bad path" }, { status: 400 })
  }
  const path = normalizePath("/", decoded)
  if (path === undefined || path === "/") return Response.json({ error: "bad path" }, { status: 400 })
  const body = request.body
  if (body === null) return Response.json({ error: "body required" }, { status: 400 })
  const type = request.headers.get("content-type") ?? typeOf(path)
  const length = contentLength(request)
  const target =
    length === undefined
      ? { kind: "buffered" as const }
      : { kind: "streamed" as const, staged: `tmp/${crypto.randomUUID()}`, length }
  try {
    const stored =
      target.kind === "buffered"
        ? await buffered(env, new Uint8Array(await request.arrayBuffer()))
        : await streamed(env, body, target.staged, target.length)
    const committed = await env.HOME.get(env.HOME.idFromName("owner")).fetch(
      new Request("https://xin.internal/v1/files/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          r2Key: blobKey(stored.digest),
          size: stored.size,
          type,
          sha256: stored.digest,
        }),
      }),
    )
    if (!committed.ok) return committed
    return Response.json({ path, size: stored.size, type, sha256: stored.digest })
  } finally {
    if (target.kind === "streamed") await env.FILES.delete(target.staged)
  }
}
