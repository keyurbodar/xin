import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { TEST_PROFILE } from "../test/worker.ts"
import type { Home } from "./host.ts"
import { blobKey, sha256 } from "./r2env.ts"

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://ingle.test${path}`, init))

describe("Worker auth", () => {
  it("serves health without a token", async () => {
    expect(await (await call("/health")).text()).toBe("ok")
  })

  it("lets an anonymous webhook through on its secret and refuses every other anonymous path", async () => {
    const owner = { authorization: "Bearer test-owner-token", "content-type": "application/json" }
    const command = async (id: string, op: string, args: unknown) => {
      const reply = await call("/v1/cmd", { method: "POST", headers: owner, body: JSON.stringify({ id, op, args }) })
      const ack = await reply.json<{ ok: boolean; result: unknown }>()
      expect(ack.ok, JSON.stringify(ack)).toBe(true)
      return ack.result
    }
    await command("hook-project", "project.create", { slug: "hooked", name: "Hooked" })
    const created = (await command("hook-create", "automation.create", {
      title: "Hook",
      prompt: "Handle it",
      project: "hooked",
      triggers: [{ kind: "webhook", rules: [{ quietSeconds: 600 }] }],
    })) as { triggers: { kind: string; path?: string }[] }
    const path = created.triggers[0]?.path ?? ""
    expect(path).toMatch(/^\/hooks\/[A-Za-z0-9_-]{43}$/)
    expect((await call(path, { method: "POST", body: "{}" })).status).toBe(202)
    expect((await call(`/hooks/${"A".repeat(43)}`, { method: "POST", body: "{}" })).status).toBe(404)
    for (const other of ["/v1/status", "/v1/cmd", "/v1/auth", "/v1/socket", "/hooks-not", "/files/x"])
      expect((await call(other, { method: "POST", body: "{}" })).status, other).toBe(401)
  })

  it("rejects a missing or wrong bearer token", async () => {
    expect((await call("/v1/status")).status).toBe(401)
    expect((await call("/v1/status", { headers: { authorization: "Bearer nope" } })).status).toBe(401)
  })

  it("routes the owner's token to the Home object", async () => {
    const reply = await call("/v1/status", { headers: { authorization: "Bearer test-owner-token" } })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({
      wake: { active: false },
      build: "dev",
      bundles: TEST_PROFILE.bundles,
    })
  })

  it("accepts the token as a WebSocket subprotocol", async () => {
    const reply = await call("/v1/status", { headers: { "sec-websocket-protocol": "ingle, bearer.test-owner-token" } })
    expect(reply.status).toBe(200)
  })

  it("accepts a rotated token and refuses the one it replaced", async () => {
    const first = await rotate()
    expect((await call("/v1/status", { headers: { authorization: `Bearer ${first}` } })).status).toBe(200)

    const second = await rotate()
    expect((await call("/v1/status", { headers: { authorization: `Bearer ${second}` } })).status).toBe(200)
    expect((await call("/v1/status", { headers: { authorization: `Bearer ${first}` } })).status).toBe(401)
    expect(
      (await call("/v1/status", { headers: { "sec-websocket-protocol": `ingle, bearer.${second}` } })).status,
    ).toBe(200)
    expect((await call("/v1/status", { headers: { authorization: "Bearer test-owner-token" } })).status).toBe(200)
  })

  it("surfaces a boot failure to a rotated-token client instead of a 401", async () => {
    const token = await rotate()
    const stub = env.HOME.get(env.HOME.idFromName("owner"))
    await runInDurableObject(stub, async (_home: Home, state) => {
      const data = new Uint8Array([0xff, 0xfe, 0x00])
      state.storage.sql.exec(
        "INSERT INTO pi_journal_ring (slot, part, seq, parts, bytes, data) VALUES (?, 0, ?, 1, ?, ?)",
        999_999,
        999_999,
        data.length,
        data.buffer,
      )
    })
    // A soft restart reopens the home, which is where the unreadable journal turns into a boot failure.
    await call("/v1/cmd", {
      method: "POST",
      headers: { authorization: "Bearer test-owner-token", "content-type": "application/json" },
      body: JSON.stringify({ id: "break-boot", op: "system.restart", args: {} }),
    })
    let failed: Response | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const reply = await call("/v1/status", { headers: { authorization: "Bearer test-owner-token" } })
      if (reply.status === 503) {
        failed = reply
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(failed?.status).toBe(503)

    const rotated = await call("/v1/status", { headers: { authorization: `Bearer ${token}` } })
    expect(rotated.status).toBe(503)
    expect(await rotated.json()).toMatchObject({ error: "boot_failed" })

    const repaired = await call("/v1/repair", {
      method: "POST",
      headers: { authorization: "Bearer test-owner-token" },
      body: JSON.stringify({ drop: "journal" }),
    })
    expect(repaired.status).toBe(200)
    expect(await repaired.json()).toMatchObject({ failure: null })
  }, 30_000)
})

const owner = () => env.HOME.get(env.HOME.idFromName("owner"))

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const dial = (presented: string) =>
  call("/v1/socket", { headers: { upgrade: "websocket", "sec-websocket-protocol": `ingle, bearer.${presented}` } })

/** Home requests and `kv` token reads one call costs, counted around it. */
async function costOf(
  send: () => Promise<Response>,
): Promise<{ status: number; requests: number; tokenReads: number }> {
  const tokenReads = async () => (await owner().meter()).statements["SELECT kv"]?.calls ?? 0
  const [requests, reads] = [await owner().requests(), await tokenReads()]
  const reply = await send()
  await reply.body?.cancel()
  return {
    status: reply.status,
    requests: (await owner().requests()) - requests,
    tokenReads: (await tokenReads()) - reads,
  }
}

describe("Home auth boundary", () => {
  const ROUTES: readonly (readonly [string, RequestInit])[] = [
    ["/v1/status", {}],
    ["/v1/cmd", { method: "POST", body: JSON.stringify({ id: "nope-1", op: "session.rotate", args: {} }) }],
    ["/v1/auth", { method: "POST" }],
    ["/v1/repair", { method: "POST", body: JSON.stringify({ drop: "all" }) }],
    ["/v1/socket", { headers: { upgrade: "websocket" } }],
    ["/v1/files/commit", { method: "POST", body: "{}" }],
    ["/v1/build/packages", {}],
  ]

  it("refuses every route called on the home directly without a valid token", async () => {
    const stub = owner()
    for (const [path, init] of ROUTES)
      for (const headers of [{}, bearer("nope"), bearer(""), { authorization: "test-owner-token" }]) {
        const reply = await stub.fetch(
          new Request(`https://ingle.internal${path}`, { ...init, headers: { ...init.headers, ...headers } }),
        )
        expect(reply.status, `${path} ${JSON.stringify(headers)}`).toBe(401)
      }
    for (const protocol of ["ingle, bearer.nope", "ingle, bearer.", "ingle"]) {
      const reply = await stub.fetch(
        new Request("https://ingle.internal/v1/socket", {
          headers: { upgrade: "websocket", "sec-websocket-protocol": protocol },
        }),
      )
      expect(reply.status, protocol).toBe(401)
    }
  })

  it("answers a bearer-less request in the Worker without waking the home", async () => {
    for (const headers of [{}, { authorization: "Bearer " }, { "sec-websocket-protocol": "ingle" }])
      expect(await costOf(() => call("/v1/status", { headers }))).toEqual({ status: 401, requests: 0, tokenReads: 0 })
  })

  it("authorizes a rotated token in the one forwarded request, with no storage read after the first", async () => {
    const token = await rotate()
    expect(await costOf(() => call("/v1/status", { headers: bearer(token) }))).toEqual({
      status: 200,
      requests: 1,
      tokenReads: 0,
    })
    expect(await costOf(() => call("/v1/status", { headers: bearer("test-owner-token") }))).toEqual({
      status: 200,
      requests: 1,
      tokenReads: 0,
    })
    expect(await costOf(() => call("/v1/status", { headers: bearer("nope") }))).toEqual({
      status: 401,
      requests: 1,
      tokenReads: 0,
    })
  })

  it("re-reads the rotated token once after an eviction and still refuses the one it replaced", async () => {
    const stub = env.HOME.get(env.HOME.newUniqueId())
    const replaced = await rotate(stub)
    const token = await rotate(stub)
    await evictDurableObject(stub)
    const status = (presented: string) =>
      stub.fetch(new Request("https://ingle.internal/v1/status", { headers: bearer(presented) }))
    const reads = async () => (await stub.meter()).statements["SELECT kv"]?.calls ?? 0
    expect((await status("test-owner-token")).status).toBe(200)
    const booted = await reads()
    expect((await status(token)).status).toBe(200)
    expect((await reads()) - booted).toBe(1)
    expect((await status(replaced)).status).toBe(401)
    expect((await status(token)).status).toBe(200)
    expect((await reads()) - booted).toBe(1)
  }, 30_000)

  it("refuses a socket handshake with a wrong or replaced token and accepts the rotated one", async () => {
    const replaced = await rotate()
    const token = await rotate()
    expect((await dial("nope")).status).toBe(401)
    expect((await dial(replaced)).status).toBe(401)
    const accepted = await dial(token)
    expect(accepted.status).toBe(101)
    accepted.webSocket?.accept()
    accepted.webSocket?.close()
  })

  it("closes an open socket on rotation, and the token it dialled with is dead at its next handshake", async () => {
    const before = await rotate()
    const reply = await dial(before)
    const ws = reply.webSocket
    if (ws === null) throw new Error(`no socket: ${reply.status}`)
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)))
    ws.accept()
    await rotate()
    expect(await closed).toBe(1000)
    expect((await dial(before)).status).toBe(401)
  })

  it("refuses an upload with a wrong or replaced token before any byte reaches R2", async () => {
    const replaced = await rotate()
    const token = await rotate()
    for (const presented of ["nope", replaced]) {
      const body = `refused-${crypto.randomUUID()}`
      const reply = await call("/files/projects/auth/refused.txt", { method: "PUT", headers: bearer(presented), body })
      expect(reply.status).toBe(401)
      expect(await env.FILES.head(blobKey(await sha256(new TextEncoder().encode(body))))).toBeNull()
    }
    const body = `accepted-${crypto.randomUUID()}`
    const accepted = await call("/files/projects/auth/accepted.txt", { method: "PUT", headers: bearer(token), body })
    expect(accepted.status).toBe(200)
    expect(await env.FILES.head(blobKey(await sha256(new TextEncoder().encode(body))))).not.toBeNull()
  })
})

async function rotate(stub?: ReturnType<typeof owner>): Promise<string> {
  const init = {
    method: "POST",
    headers: { authorization: "Bearer test-owner-token", "content-type": "application/json" },
    body: JSON.stringify({ id: `rotate-${crypto.randomUUID()}`, op: "session.rotate", args: {} }),
  }
  const reply = await (stub === undefined ? call("/v1/cmd", init) : stub.fetch("https://ingle.internal/v1/cmd", init))
  const body = await reply.json<{ ok: boolean; result?: unknown }>()
  const token = typeof body.result === "object" && body.result !== null ? Reflect.get(body.result, "token") : undefined
  if (!body.ok || typeof token !== "string") throw new Error(`session.rotate: ${JSON.stringify(body)}`)
  return token
}
