import { expect, test } from "bun:test"
import { OpError } from "../lib/api.ts"
import { consentOf, installFromMarket } from "./extensions.ts"

const PIN = `sha512-${"A".repeat(86)}==`
const PERMISSIONS = [{ id: "network", title: "Reach the network", why: "guarded declares it" }]

test("a consent request carries the registry pin the market sent", () => {
  expect(consentOf(new OpError("consent_required", "asks", { permissions: PERMISSIONS, integrity: PIN }))).toEqual({
    permissions: PERMISSIONS,
    integrity: PIN,
    changed: false,
  })
})

test("a consent request says the package changed only when the market says so", () => {
  for (const [changed, expected] of [[true, true], ["true", false], [undefined, false]] as const)
    expect(
      consentOf(new OpError("consent_required", "asks", { permissions: PERMISSIONS, integrity: PIN, changed }))?.changed,
    ).toBe(expected)
})

test("a consent request without a well-formed sha512 pin carries none", () => {
  for (const integrity of [undefined, "", `sha256-${"A".repeat(43)}=`, `sha512-${"A".repeat(10)}==`])
    expect(consentOf(new OpError("consent_required", "asks", { permissions: PERMISSIONS, integrity }))?.integrity).toBeUndefined()
})

test("another failure is not a consent request", () => {
  expect(consentOf(new OpError("bad_args", "nope", { integrity: PIN }))).toBeUndefined()
  expect(consentOf(new Error("nope"))).toBeUndefined()
})

test("a grant sends back the pin of the consent it answers, and a grant without one sends none", async () => {
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as { readonly id: string; readonly op: string; readonly args: unknown }[]
    for (const frame of frames) if (frame.op === "market.install") sent.push(frame.args)
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: { application: "pending", rows: [] } }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
  try {
    await installFromMarket("ingle-plugin-code", ["network"], PIN)
    await installFromMarket("ingle-plugin-code", ["network"])
  } finally {
    globalThis.fetch = realFetch
  }
  expect(sent).toEqual([
    { name: "ingle-plugin-code", grant: ["network"], integrity: PIN },
    { name: "ingle-plugin-code", grant: ["network"] },
  ])
})
