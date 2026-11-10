import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { TEST_PROFILE } from "../test/worker.ts"
import type { Home } from "./host.ts"

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://xin.test${path}`, init))

describe("Worker auth", () => {
  it("serves health without a token", async () => {
    expect(await (await call("/health")).text()).toBe("ok")
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
    const reply = await call("/v1/status", { headers: { "sec-websocket-protocol": "xin, bearer.test-owner-token" } })
    expect(reply.status).toBe(200)
  })

  it("accepts a rotated token and refuses the one it replaced", async () => {
    const first = await rotate()
    expect((await call("/v1/status", { headers: { authorization: `Bearer ${first}` } })).status).toBe(200)

    const second = await rotate()
    expect((await call("/v1/status", { headers: { authorization: `Bearer ${second}` } })).status).toBe(200)
    expect((await call("/v1/status", { headers: { authorization: `Bearer ${first}` } })).status).toBe(401)
    expect((await call("/v1/status", { headers: { "sec-websocket-protocol": `xin, bearer.${second}` } })).status).toBe(
      200,
    )
    expect((await call("/v1/status", { headers: { authorization: "Bearer test-owner-token" } })).status).toBe(200)
  })

  it("surfaces a boot failure to a rotated-token client instead of a 401", async () => {
    const token = await rotate()
    const stub = env.HOME.get(env.HOME.idFromName("owner"))
    await runInDurableObject(stub, async (_home: Home, state) => {
      const data = new Uint8Array([0xff, 0xfe, 0x00])
      state.storage.sql.exec(
        "INSERT INTO pi_journal (seq, part, parts, bytes, data) VALUES (?, 0, 1, ?, ?)",
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

async function rotate(): Promise<string> {
  const reply = await call("/v1/cmd", {
    method: "POST",
    headers: { authorization: "Bearer test-owner-token", "content-type": "application/json" },
    body: JSON.stringify({ id: `rotate-${crypto.randomUUID()}`, op: "session.rotate", args: {} }),
  })
  const body = await reply.json<{ ok: boolean; result?: unknown }>()
  const token = typeof body.result === "object" && body.result !== null ? Reflect.get(body.result, "token") : undefined
  if (!body.ok || typeof token !== "string") throw new Error(`session.rotate: ${JSON.stringify(body)}`)
  return token
}
