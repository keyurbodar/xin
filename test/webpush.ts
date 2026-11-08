import { fromBase64Url, pushTopic, toBase64Url } from "../plugins/push/webpush.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type Subscriber = {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly privateKey: CryptoKey
  readonly publicKey: Uint8Array
  readonly authSecret: Uint8Array
}

export async function subscriber(endpoint: string): Promise<Subscriber> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!("privateKey" in pair)) throw new Error("expected an ECDH key pair")
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey)
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected a raw P-256 key")
  const publicKey = new Uint8Array(raw)
  const authSecret = crypto.getRandomValues(new Uint8Array(16))
  return {
    endpoint,
    keys: { p256dh: toBase64Url(publicKey), auth: toBase64Url(authSecret) },
    privateKey: pair.privateKey,
    publicKey,
    authSecret,
  }
}

export async function decrypt(target: Subscriber, body: Uint8Array): Promise<unknown> {
  const salt = body.slice(0, 16)
  const idLength = body[20]
  if (idLength === undefined) throw new Error("truncated push body")
  const ephemeralKey = body.slice(21, 21 + idLength)
  const ciphertext = body.slice(21 + idLength)
  const ephemeral = await crypto.subtle.importKey("raw", ephemeralKey, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const ecdh: SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey } = { name: "ECDH", public: ephemeral }
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, target.privateKey, 256))
  const ikm = await hkdf(
    shared,
    target.authSecret,
    concat(encoder.encode("WebPush: info\0"), target.publicKey, ephemeralKey),
    256,
  )
  const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 128)
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 96)
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, ciphertext),
  )
  let end = record.length
  while (end > 0 && record[end - 1] === 0) end -= 1
  if (record[end - 1] !== 2) throw new Error("missing record delimiter")
  return JSON.parse(decoder.decode(record.slice(0, end - 1)))
}

export function decodeVapid(authorization: string | null): { token: string; publicKey: string } {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization ?? "")
  if (match === null) throw new Error("unexpected authorization header")
  const token = match[1]
  const publicKey = match[2]
  if (token === undefined || publicKey === undefined) throw new Error("incomplete authorization header")
  return { token, publicKey }
}

export function tokenParts(token: string): { header: string; claims: string; signature: string } {
  const [header, claims, signature] = token.split(".")
  if (header === undefined || claims === undefined || signature === undefined) throw new Error("incomplete token")
  return { header, claims, signature }
}

export { encoder, decoder, fromBase64Url, pushTopic, toBase64Url }

async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"])
  const algorithm: SubtleCryptoDeriveKeyAlgorithm = { name: "HKDF", hash: "SHA-256", salt, info }
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, key, bits))
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
