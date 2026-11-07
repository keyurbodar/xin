import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import profile from "../xin.profile.json"

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
      bundles: [...profile.bundles, "test"],
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
