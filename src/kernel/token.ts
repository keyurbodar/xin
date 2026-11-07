import type { SqliteDatabase } from "@earendil-works/chord/sqlite"

const TOKEN_KEY = "owner.token"
const TOKEN_BYTES = 32
const encoder = new TextEncoder()

/** A fresh owner token: the prefix marks what it is, the body is 32 random bytes in URL-safe base64. */
export function mintToken(): string {
  return `own_${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`
}

/** What the store keeps: the digest, never the token. */
export async function hashToken(token: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))))
}

/** Mints a token, makes it the only rotated token that works, and answers it for the one moment it is readable. */
export async function rotateToken(db: SqliteDatabase): Promise<string> {
  const token = mintToken()
  await db.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    TOKEN_KEY,
    await hashToken(token),
  )
  return token
}

/** True when the presented token is the current rotated one. The deploy token is checked before this. */
export async function rotatedTokenMatches(db: SqliteDatabase, presented: string): Promise<boolean> {
  const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", TOKEN_KEY)
  if (row === undefined) return false
  const [expected, actual] = [encoder.encode(row.value), encoder.encode(await hashToken(presented))]
  return expected.byteLength === actual.byteLength && crypto.subtle.timingSafeEqual(expected, actual)
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
