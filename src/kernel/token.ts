import type { SqliteDatabase } from "@earendil-works/chord/sqlite"

const TOKEN_KEY = "owner.token"
const TOKEN_BYTES = 32
const encoder = new TextEncoder()

/** A fresh owner token: the prefix marks what it is, the body is 32 random bytes in URL-safe base64. */
function mintToken(): string {
  return `own_${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`
}

/** What the store keeps: the digest, never the token. */
async function hashToken(token: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))))
}

/** The bearer a request presents: the `Authorization` header, or the `bearer.<token>` WebSocket subprotocol. */
export function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? ""
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length)
  const protocol = request.headers.get("sec-websocket-protocol") ?? ""
  const token = protocol
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("bearer."))
  return token?.slice("bearer.".length)
}

export function sameToken(a: string, b: string): boolean {
  const [left, right] = [encoder.encode(a), encoder.encode(b)]
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right)
}

/**
 * The home's one auth check. It accepts the deploy token or the current rotated token, whose digest is read from `kv`
 * once and then held in memory; `session.rotate` replaces the held digest in the same step that writes it, so a
 * rotation takes effect at once and an old token is refused on its next request.
 */
export class OwnerAuth {
  /** `undefined` until read, `null` when no token was ever rotated. */
  #rotated: string | null | undefined

  constructor(
    private readonly sql: SqlStorage,
    private readonly deploy: string,
  ) {}

  async authorizes(request: Request): Promise<boolean> {
    const presented = bearer(request)
    if (presented === undefined || presented === "") return false
    if (this.deploy !== "" && sameToken(presented, this.deploy)) return true
    const expected = this.#stored()
    return expected !== null && sameToken(await hashToken(presented), expected)
  }

  /** Mints a token, makes it the only rotated token that works, and answers it for the one moment it is readable. */
  async rotate(db: SqliteDatabase): Promise<string> {
    const token = mintToken()
    const hash = await hashToken(token)
    await db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      TOKEN_KEY,
      hash,
    )
    this.#rotated = hash
    return token
  }

  /**
   * Read through the raw storage, so a home whose kernel failed to boot still knows its rotated token. A read that
   * throws (no `kv` table yet) is not cached, so the next request tries again.
   */
  #stored(): string | null {
    if (this.#rotated !== undefined) return this.#rotated
    try {
      const rows = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", TOKEN_KEY).toArray()
      this.#rotated = rows[0]?.value ?? null
    } catch {
      return null
    }
    return this.#rotated
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
