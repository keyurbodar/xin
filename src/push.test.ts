import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { api, connect, owner } from "../test/support.ts"
import { decodeVapid, decrypt, encoder, fromBase64Url, subscriber, tokenParts } from "../test/webpush.ts"
import type { Home } from "../test/worker.ts"
import { notifier, type Notification } from "./push.ts"
import { RECORD_SIZE, toBase64Url } from "./webpush.ts"

const decoder = new TextDecoder()

async function subscribe(id: string, target: { endpoint: string; keys: unknown }): Promise<void> {
  const reply = await api("/v1/cmd", {
    method: "POST",
    body: JSON.stringify({ id, op: "push.subscribe", args: { endpoint: target.endpoint, keys: target.keys } }),
  })
  expect(await reply.json()).toMatchObject({ t: "ack", id, ok: true })
}

async function reject(id: string, endpoint: string, keys: unknown): Promise<void> {
  const reply = await api("/v1/cmd", {
    method: "POST",
    body: JSON.stringify({ id, op: "push.subscribe", args: { endpoint, keys } }),
  })
  expect(await reply.json()).toMatchObject({ ok: false, error: { code: "bad_args" } })
}

function message(tag: string): Notification {
  return { threadTitle: "Parser thread", title: "Parser thread", body: "Ready for review", tag }
}

async function verifyVapid(request: Request, audience: string): Promise<void> {
  expect(request.method).toBe("POST")
  expect(request.headers.get("content-encoding")).toBe("aes128gcm")
  expect(request.headers.get("content-type")).toBe("application/octet-stream")
  expect(request.headers.get("ttl")).toBe("86400")
  expect(request.headers.get("urgency")).toBe("high")

  const { token, publicKey } = decodeVapid(request.headers.get("authorization"))
  const { header, claims, signature } = tokenParts(token)
  expect(JSON.parse(decoder.decode(fromBase64Url(header)))).toEqual({ typ: "JWT", alg: "ES256" })
  const parsed: unknown = JSON.parse(decoder.decode(fromBase64Url(claims)))
  expect(parsed).toMatchObject({ aud: audience })
  if (typeof parsed !== "object" || parsed === null || !("exp" in parsed) || typeof parsed.exp !== "number")
    throw new Error("token has no expiry")
  expect(parsed.exp * 1000).toBeGreaterThan(Date.now())

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
}

describe("web push delivery", () => {
  beforeEach(async () => {
    await runInDurableObject(owner(), async (home: Home) => {
      await home.db.run("DELETE FROM push_subs")
    })
  })

  it("sends one encrypted POST per subscription when no socket is open", async () => {
    const first = await subscriber("https://push.example.test/first")
    const second = await subscriber("https://push.example.test/second")
    await subscribe("push-sub-first", first)
    await subscribe("push-sub-second", second)
    const notification = message("thread-9")

    await runInDurableObject(owner(), async (home: Home, state) => {
      const sent: Request[] = []
      await notifier({ ctx: state, db: home.db, env }, async (request) => {
        sent.push(request)
        return new Response(null, { status: 201 })
      }).notify(notification)

      expect(sent).toHaveLength(2)
      for (const target of [first, second]) {
        const matches = sent.filter((request) => request.url === target.endpoint)
        expect(matches).toHaveLength(1)
        const request = matches[0]
        if (request === undefined) throw new Error("missing request")
        await verifyVapid(request, new URL(target.endpoint).origin)
        expect(await decrypt(target, new Uint8Array(await request.arrayBuffer()))).toEqual(notification)
      }
    })
  })

  it("sends nothing while a socket is connected", async () => {
    const target = await subscriber("https://push.example.test/connected")
    await subscribe("push-sub-connected", target)
    const socket = await connect()
    try {
      await runInDurableObject(owner(), async (home: Home, state) => {
        expect(state.getWebSockets()).toHaveLength(1)
        const sent: Request[] = []
        await notifier({ ctx: state, db: home.db, env }, async (request) => {
          sent.push(request)
          return new Response(null, { status: 201 })
        }).notify(message("thread-connected"))
        expect(sent).toHaveLength(0)
      })
    } finally {
      socket.close()
    }
  })

  it("rejects keys a browser could never produce without storing them", async () => {
    const valid = await subscriber("https://push.example.test/bad-keys")
    const badPrefix = new Uint8Array(65)
    badPrefix[0] = 5
    await reject("push-bad-short-point", valid.endpoint, {
      p256dh: toBase64Url(new Uint8Array(64)),
      auth: valid.keys.auth,
    })
    await reject("push-bad-prefix", valid.endpoint, { p256dh: toBase64Url(badPrefix), auth: valid.keys.auth })
    await reject("push-bad-auth", valid.endpoint, {
      p256dh: valid.keys.p256dh,
      auth: toBase64Url(new Uint8Array(15)),
    })
    await reject("push-bad-base64", valid.endpoint, { p256dh: "!!!!", auth: valid.keys.auth })

    await runInDurableObject(owner(), async (home: Home) => {
      expect(await home.db.all("SELECT endpoint FROM push_subs")).toEqual([])
    })
  })

  it("fits an oversized notification into one record", async () => {
    const target = await subscriber("https://push.example.test/big")
    await subscribe("push-sub-big", target)
    const notification: Notification = {
      threadTitle: "T".repeat(300),
      title: "t".repeat(5000),
      body: "b".repeat(20_000),
      tag: "thread-big",
    }

    await runInDurableObject(owner(), async (home: Home, state) => {
      const sent: Request[] = []
      await notifier({ ctx: state, db: home.db, env }, async (request) => {
        sent.push(request)
        return new Response(null, { status: 201 })
      }).notify(notification)

      expect(sent).toHaveLength(1)
      const request = sent[0]
      if (request === undefined) throw new Error("missing request")
      const body = new Uint8Array(await request.arrayBuffer())
      expect(body.length).toBeLessThanOrEqual(RECORD_SIZE)
      const payload = await decrypt(target, body)
      expect(payload).toMatchObject({ threadTitle: "T".repeat(300), tag: "thread-big" })
      expect(JSON.stringify(payload).length).toBeLessThanOrEqual(RECORD_SIZE - 17)
    })
  })

  it("keeps delivering when one endpoint answers 500 and prunes only the one that is gone", async () => {
    const failing = await subscriber("https://push.example.test/failing")
    const alive = await subscriber("https://push.example.test/alive")
    const doomed = await subscriber("https://push.example.test/doomed")
    await subscribe("push-sub-failing", failing)
    await subscribe("push-sub-alive", alive)
    await subscribe("push-sub-doomed", doomed)

    await runInDurableObject(owner(), async (home: Home, state) => {
      const seen: string[] = []
      await notifier({ ctx: state, db: home.db, env }, async (request) => {
        seen.push(request.url)
        if (request.url.endsWith("/failing")) return new Response(null, { status: 500 })
        if (request.url.endsWith("/doomed")) return new Response(null, { status: 410 })
        return new Response(null, { status: 201 })
      }).notify(message("thread-partial"))

      expect(new Set(seen)).toEqual(new Set([failing.endpoint, alive.endpoint, doomed.endpoint]))
      expect(await home.db.all<{ endpoint: string }>("SELECT endpoint FROM push_subs ORDER BY endpoint")).toEqual([
        { endpoint: alive.endpoint },
        { endpoint: failing.endpoint },
      ])
    })
  })

  it("sets the same RFC 8030 Topic for the same tag", async () => {
    const target = await subscriber("https://push.example.test/topic")
    await subscribe("push-sub-topic", target)

    await runInDurableObject(owner(), async (home: Home, state) => {
      const topics: (string | null)[] = []
      const push = notifier({ ctx: state, db: home.db, env }, async (request) => {
        topics.push(request.headers.get("topic"))
        return new Response(null, { status: 201 })
      })
      await push.notify(message("thread-same"))
      await push.notify(message("thread-same"))
      await push.notify(message("thread-other"))

      const [first, second, other] = topics
      if (first === null || second === null || other === null) throw new Error("missing topic header")
      expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
      expect(second).toBe(first)
      expect(other).not.toBe(first)
    })
  })
})
