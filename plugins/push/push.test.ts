import { runInDurableObject } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { api, cmd, connect, fresh, owner, type Stub } from "../../test/support.ts"
import { decodeVapid, decrypt, encoder, fromBase64Url, subscriber, tokenParts } from "../../test/webpush.ts"
import type { Home } from "../../test/worker.ts"
import { notifier, testPush, type Notification } from "./push.ts"
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

function message(tag: string, kind: Notification["kind"] = "finished"): Notification {
  return { threadTitle: "Parser thread", title: "Parser thread", body: "Ready for review", tag, kind }
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
      await notifier({ state, db: home.db }, async (request) => {
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
        expect(await decrypt(target, new Uint8Array(await request.arrayBuffer()))).toEqual({
          threadTitle: notification.threadTitle,
          title: notification.title,
          body: notification.body,
          tag: notification.tag,
        })
      }
    })
  })

  it("answers a test with one POST per subscription even while a socket is open", async () => {
    const target = await subscriber("https://push.example.test/test-op")
    await subscribe("push-sub-test", target)
    const socket = await connect()
    try {
      const calls: string[] = []
      const sent = await runInDurableObject(owner(), (home: Home) =>
        testPush(home.db, async (request) => {
          calls.push(request.url)
          return new Response(null, { status: 201 })
        }),
      )
      expect(calls).toEqual([target.endpoint])
      expect(sent).toBe(1)
    } finally {
      socket.close()
    }
  })

  it("sends nothing while a socket is connected", async () => {
    const target = await subscriber("https://push.example.test/connected")
    await subscribe("push-sub-connected", target)
    const socket = await connect()
    try {
      await runInDurableObject(owner(), async (home: Home, state) => {
        expect(state.getWebSockets()).toHaveLength(1)
        const sent: Request[] = []
        await notifier({ state, db: home.db }, async (request) => {
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
      kind: "finished",
    }

    await runInDurableObject(owner(), async (home: Home, state) => {
      const sent: Request[] = []
      await notifier({ state, db: home.db }, async (request) => {
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
      await notifier({ state, db: home.db }, async (request) => {
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
      const push = notifier({ state, db: home.db }, async (request) => {
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

async function listen(stub: Stub, endpoint: string): Promise<void> {
  const target = await subscriber(endpoint)
  const ack = await cmd(stub, `sub-${crypto.randomUUID()}`, "push.subscribe", {
    endpoint: target.endpoint,
    keys: target.keys,
  })
  expect(ack).toMatchObject({ ok: true })
}

function deliverAt(stub: Stub, at: string, notification: Notification): Promise<string[]> {
  return runInDurableObject(stub, async (home: Home, state) => {
    const sent: string[] = []
    await notifier(
      { state, db: home.db },
      async (request) => {
        sent.push(request.url)
        return new Response(null, { status: 201 })
      },
      () => Date.parse(at),
    ).notify(notification)
    return sent
  })
}

function holdAt(stub: Stub, at: string, notification: Notification): Promise<number | undefined> {
  return runInDurableObject(stub, async (home: Home, state) => {
    const push = notifier(
      { state, db: home.db },
      () => Promise.reject(new Error("nothing should be sent during quiet hours")),
      () => Date.parse(at),
    )
    await push.notify(notification)
    return push.due()
  })
}

function flushAt(stub: Stub, at: string): Promise<string[]> {
  return runInDurableObject(stub, async (home: Home, state) => {
    const sent: string[] = []
    await notifier(
      { state, db: home.db },
      async (request) => {
        sent.push(request.url)
        return new Response(null, { status: 201 })
      },
      () => Date.parse(at),
    ).flush(Date.parse(at))
    return sent
  })
}

describe("quiet hours", () => {
  it("holds every kind through the night", async () => {
    const stub = fresh()
    const endpoint = "https://push.example.com/night"
    const quiet = { enabled: true, start: 1320, end: 420 }
    expect((await cmd(stub, "quiet-night", "notify.quiet.set", quiet)).result).toEqual(quiet)
    await listen(stub, endpoint)

    expect(await deliverAt(stub, "2026-11-07T23:30:00Z", message("night-finished"))).toEqual([])
    expect(await deliverAt(stub, "2026-11-07T23:30:00Z", message("night-failed", "failed"))).toEqual([])
    expect(await deliverAt(stub, "2026-11-07T23:30:00Z", message("night-waiting", "waiting"))).toEqual([])
  })

  it("delivers everything by day, and at night when quiet hours are off", async () => {
    const stub = fresh()
    const endpoint = "https://push.example.com/day"
    await listen(stub, endpoint)
    expect((await cmd(stub, "quiet-day", "notify.quiet.set", { enabled: true, start: 1320, end: 420 })).ok).toBe(true)

    expect(await deliverAt(stub, "2026-11-07T12:00:00Z", message("day-finished"))).toEqual([endpoint])
    expect(await deliverAt(stub, "2026-11-07T12:00:00Z", message("day-waiting", "waiting"))).toEqual([endpoint])

    expect((await cmd(stub, "quiet-off", "notify.quiet.set", { enabled: false })).ok).toBe(true)
    expect(await deliverAt(stub, "2026-11-07T23:30:00Z", message("off-finished"))).toEqual([endpoint])
  })

  it("holds a report until the window ends, then sends it once", async () => {
    const stub = fresh()
    const endpoint = "https://push.example.com/morning"
    await listen(stub, endpoint)
    await cmd(stub, "queue-quiet", "notify.quiet.set", { enabled: true, start: 1320, end: 420 })

    expect(await holdAt(stub, "2026-11-07T23:30:00Z", message("queued-finished"))).toBe(
      Date.parse("2026-11-08T07:00:00Z"),
    )
    expect(await flushAt(stub, "2026-11-08T06:59:00Z")).toEqual([])
    expect(await flushAt(stub, "2026-11-08T07:00:00Z")).toEqual([endpoint])
    expect(await flushAt(stub, "2026-11-08T09:00:00Z")).toEqual([])
  })

  it("releases a question after two hours paused, before the window ends", async () => {
    const stub = fresh()
    const endpoint = "https://push.example.com/night-question"
    await listen(stub, endpoint)
    await cmd(stub, "queue-question", "notify.quiet.set", { enabled: true, start: 1320, end: 420 })

    expect(await holdAt(stub, "2026-11-07T23:30:00Z", message("queued-waiting", "waiting"))).toBe(
      Date.parse("2026-11-08T01:30:00Z"),
    )
    expect(await flushAt(stub, "2026-11-08T01:29:00Z")).toEqual([])
    expect(await flushAt(stub, "2026-11-08T01:30:00Z")).toEqual([endpoint])
    expect(await flushAt(stub, "2026-11-08T08:00:00Z")).toEqual([])
  })

  it("releases a question when the window ends first", async () => {
    const stub = fresh()
    await listen(stub, "https://push.example.com/dawn-question")
    await cmd(stub, "queue-dawn", "notify.quiet.set", { enabled: true, start: 1320, end: 420 })

    expect(await holdAt(stub, "2026-11-08T06:30:00Z", message("dawn-waiting", "waiting"))).toBe(
      Date.parse("2026-11-08T07:00:00Z"),
    )
  })

  it("keeps a held notification whose send pass throws, for a later retry", async () => {
    const stub = fresh()
    const endpoint = "https://push.example.com/held-retry"
    await listen(stub, endpoint)
    await cmd(stub, "queue-retry", "notify.quiet.set", { enabled: true, start: 1320, end: 420 })
    expect(await holdAt(stub, "2026-11-07T23:30:00Z", message("held-retry"))).toBe(Date.parse("2026-11-08T07:00:00Z"))

    const kept = await runInDurableObject(stub, async (home: Home, state) => {
      // A storage failure inside the send pass makes it throw, which is the case the ordering has to survive.
      await home.db.run("DROP TABLE push_subs")
      const push = notifier(
        { state, db: home.db },
        async () => new Response(null, { status: 201 }),
        () => Date.parse("2026-11-08T07:00:00Z"),
      )
      const sent = await push.flush(Date.parse("2026-11-08T07:00:00Z"))
      return { sent, due: await push.due() }
    })
    expect(kept.sent).toBe(0)
    expect(kept.due).toBe(Date.parse("2026-11-08T07:00:00Z") + 5 * 60_000)
  })

  it("sends a test push even during quiet hours", async () => {
    const stub = fresh()
    const endpoint = "https://push.example.com/test"
    await listen(stub, endpoint)
    await cmd(stub, "queue-test", "notify.quiet.set", { enabled: true, start: 0, end: 1439 })

    const sent = await runInDurableObject(stub, async (home: Home) => {
      const urls: string[] = []
      await testPush(home.db, async (request) => {
        urls.push(request.url)
        return new Response(null, { status: 201 })
      })
      return urls
    })
    expect(sent).toEqual([endpoint])
  })
})

describe("notification settings", () => {
  it("merges quiet hours one field at a time", async () => {
    const stub = fresh()
    expect((await cmd(stub, "quiet-enable", "notify.quiet.set", { enabled: true })).result).toEqual({
      enabled: true,
      start: 1320,
      end: 420,
    })
    expect((await cmd(stub, "quiet-start", "notify.quiet.set", { start: 600 })).result).toEqual({
      enabled: true,
      start: 600,
      end: 420,
    })
    expect((await cmd(stub, "quiet-read", "notify.quiet")).result).toEqual({ enabled: true, start: 600, end: 420 })
  })

  it("rejects a minute outside a day", async () => {
    const stub = fresh()
    for (const args of [{ start: 1440 }, { start: -1 }, { start: 1.5 }]) {
      expect(await cmd(stub, `quiet-bad-${args.start}`, "notify.quiet.set", args)).toMatchObject({
        ok: false,
        error: { code: "bad_args" },
      })
    }
  })
})

describe("devices", () => {
  it("lists a subscribed device by endpoint and origin, and drops it on unsubscribe", async () => {
    const stub = fresh()
    const target = await subscriber("https://push.example.com/phone")
    expect(await cmd(stub, "devices-empty", "push.list")).toMatchObject({ ok: true, result: [] })

    expect(
      await cmd(stub, "devices-sub", "push.subscribe", { endpoint: target.endpoint, keys: target.keys }),
    ).toMatchObject({ ok: true })
    expect((await cmd(stub, "devices-one", "push.list")).result).toEqual([
      { endpoint: target.endpoint, origin: "https://push.example.com" },
    ])

    expect(await cmd(stub, "devices-unsub", "push.unsubscribe", { endpoint: target.endpoint })).toMatchObject({
      ok: true,
    })
    expect((await cmd(stub, "devices-none", "push.list")).result).toEqual([])
  })
})
