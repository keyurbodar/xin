import { describe, expect, it } from "vitest"
import { decodeVapid, decoder, decrypt, fromBase64Url, subscriber, tokenParts } from "../../test/webpush.ts"
import {
  encryptPayload,
  generateVapid,
  PAYLOAD_LIMIT,
  pushTopic,
  toBase64Url,
  vapidAuthorization,
  vapidPublicKey,
  vapidSigner,
} from "./webpush.ts"

const encoder = new TextEncoder()

describe("web push", () => {
  it("encrypts an aes128gcm payload the subscriber can decrypt", async () => {
    const target = await subscriber("https://push.example.test/one")
    const payload = { threadTitle: "Parser thread", title: "Parser thread", body: "Ready for review", tag: "thread-42" }
    const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)))

    expect(body[20]).toBe(65)
    expect(await decrypt(target, body)).toEqual(payload)
  })

  it("refuses plaintext beyond one aes128gcm record", async () => {
    const target = await subscriber("https://push.example.test/limit")
    await expect(encryptPayload(target, new Uint8Array(PAYLOAD_LIMIT + 1))).rejects.toThrow("record")
    const body = await encryptPayload(target, new Uint8Array(PAYLOAD_LIMIT))
    expect(body.length).toBeLessThanOrEqual(4096)
  })

  it("signs a VAPID token the push service can verify", async () => {
    const jwk = await generateVapid()
    const signer = await vapidSigner(jwk)
    const audience = "https://push.example.test"
    const now = 1_700_000_000_000
    const authorization = await vapidAuthorization(signer, audience, now)

    const { token, publicKey } = decodeVapid(authorization)
    expect(publicKey).toBe(signer.publicKey)

    const { header, claims, signature } = tokenParts(token)
    expect(JSON.parse(decoder.decode(fromBase64Url(header)))).toEqual({ typ: "JWT", alg: "ES256" })
    expect(JSON.parse(decoder.decode(fromBase64Url(claims)))).toMatchObject({
      aud: audience,
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: "mailto:xin@localhost",
    })

    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(signature),
      encoder.encode(`${header}.${claims}`),
    )
    expect(valid).toBe(true)
  })

  it("derives the VAPID public key from the stored JWK coordinates", async () => {
    const jwk = await generateVapid()
    const expected = new Uint8Array(65)
    expected[0] = 4
    expected.set(fromBase64Url(jwk.x), 1)
    expected.set(fromBase64Url(jwk.y), 33)
    expect(vapidPublicKey(jwk)).toBe(toBase64Url(expected))
  })

  it("derives a stable, short RFC 8030 topic from a tag", async () => {
    const first = await pushTopic("thread-42")
    const second = await pushTopic("thread-42")
    const other = await pushTopic("thread-43")
    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(fromBase64Url(first)).toHaveLength(24)
  })
})
