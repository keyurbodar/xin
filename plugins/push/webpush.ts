import { compile, lit, obj, str, type Static } from "@earendil-works/pi-schema"

const encoder = new TextEncoder()
const WEB_PUSH_INFO = encoder.encode("WebPush: info\0")
const CONTENT_ENCODING_INFO = encoder.encode("Content-Encoding: aes128gcm\0")
const NONCE_INFO = encoder.encode("Content-Encoding: nonce\0")
const VAPID_LIFETIME_S = 12 * 60 * 60
const VAPID_SUBJECT = "mailto:xin@localhost"
const TOPIC_BYTES = 24
const UNCOMPRESSED = 0x04
const P256_PUBLIC_BYTES = 65
const P256_COORDINATE_BYTES = 32
const AUTH_BYTES = 16

export const RECORD_SIZE = 4096
const HEADER_BYTES = 16 + 4 + 1 + 65
export const PAYLOAD_LIMIT = RECORD_SIZE - HEADER_BYTES - 17

export const SubscriptionKeys = obj({
  p256dh: str({ minLength: 1, maxLength: 256 }),
  auth: str({ minLength: 1, maxLength: 256 }),
})
export type SubscriptionKeys = Static<typeof SubscriptionKeys>

export const Subscription = obj({
  endpoint: str({ minLength: 1, maxLength: 2048 }),
  keys: SubscriptionKeys,
})
export type Subscription = Static<typeof Subscription>
export const subscriptionCheck = compile(Subscription)

export const VapidJwk = obj({
  kty: lit("EC"),
  crv: lit("P-256"),
  x: str({ minLength: 1 }),
  y: str({ minLength: 1 }),
  d: str({ minLength: 1 }),
})
export type VapidJwk = Static<typeof VapidJwk>
export const vapidCheck = compile(VapidJwk)

export type VapidSigner = {
  readonly key: CryptoKey
  readonly publicKey: string
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function validSubscriptionKeys(keys: SubscriptionKeys): Promise<boolean> {
  let p256dh: Uint8Array
  let auth: Uint8Array
  try {
    p256dh = fromBase64Url(keys.p256dh)
    auth = fromBase64Url(keys.auth)
  } catch {
    return false
  }
  if (p256dh.length !== P256_PUBLIC_BYTES || p256dh[0] !== UNCOMPRESSED || auth.length !== AUTH_BYTES) return false
  try {
    await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, [])
  } catch {
    return false
  }
  return true
}

export async function generateVapid(): Promise<VapidJwk> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  if (!("privateKey" in pair)) throw new Error("expected an ECDSA key pair")
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey)
  if (exported instanceof ArrayBuffer) throw new Error("expected a JWK")
  const { kty, crv, x, y, d } = exported
  if (x === undefined || y === undefined || d === undefined) throw new Error("incomplete P-256 JWK")
  const jwk: unknown = { kty, crv, x, y, d }
  if (!vapidCheck.check(jwk)) throw new Error("expected a P-256 JWK")
  return jwk
}

export function vapidPublicKey(jwk: VapidJwk): string {
  const x = fromBase64Url(jwk.x)
  const y = fromBase64Url(jwk.y)
  if (x.length !== P256_COORDINATE_BYTES || y.length !== P256_COORDINATE_BYTES)
    throw new Error("P-256 coordinates must be 32 bytes")
  return toBase64Url(concat(Uint8Array.of(UNCOMPRESSED), x, y))
}

export async function vapidSigner(jwk: VapidJwk): Promise<VapidSigner> {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return { key, publicKey: vapidPublicKey(jwk) }
}

export async function vapidAuthorization(signer: VapidSigner, audience: string, now = Date.now()): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + VAPID_LIFETIME_S,
        sub: VAPID_SUBJECT,
      }),
    ),
  )
  const token = `${header}.${claims}`
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.key, encoder.encode(token))
  return `vapid t=${token}.${toBase64Url(new Uint8Array(signature))}, k=${signer.publicKey}`
}

export async function pushTopic(tag: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(tag)))
  return toBase64Url(digest.subarray(0, TOPIC_BYTES))
}

export async function encryptPayload(subscription: Subscription, plaintext: Uint8Array): Promise<Uint8Array> {
  if (plaintext.length > PAYLOAD_LIMIT) throw new RangeError("push payload does not fit one aes128gcm record")
  const subscriberKey = fromBase64Url(subscription.keys.p256dh)
  const authSecret = fromBase64Url(subscription.keys.auth)

  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  if (!("privateKey" in ephemeral)) throw new Error("expected an ECDH key pair")
  const raw = await crypto.subtle.exportKey("raw", ephemeral.publicKey)
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected a raw P-256 key")
  const ephemeralKey = new Uint8Array(raw)

  const subscriberPublic = await crypto.subtle.importKey(
    "raw",
    subscriberKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const ecdh: SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey } = {
    name: "ECDH",
    public: subscriberPublic,
  }
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ephemeral.privateKey, 256))
  const ikm = await hkdf(shared, authSecret, concat(WEB_PUSH_INFO, subscriberKey, ephemeralKey), 256)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(ikm, salt, CONTENT_ENCODING_INFO, 128)
  const nonce = await hkdf(ikm, salt, NONCE_INFO, 96)

  const record = new Uint8Array(plaintext.length + 1)
  record.set(plaintext)
  record[plaintext.length] = 2

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, record),
  )

  const header = new Uint8Array(16 + 4 + 1 + ephemeralKey.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = ephemeralKey.length
  header.set(ephemeralKey, 21)
  return concat(header, ciphertext)
}

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
