import { exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

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
      bundles: ["xin-base", "xin-plugin-time", "test"],
    })
  })

  it("accepts the token as a WebSocket subprotocol", async () => {
    const reply = await call("/v1/status", { headers: { "sec-websocket-protocol": "xin, bearer.test-owner-token" } })
    expect(reply.status).toBe(200)
  })
})
