import { afterEach, expect, test } from "bun:test"
import { probe } from "./auth.ts"

const realFetch = globalThis.fetch

function answer(make: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => make()) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

test("probe tells ok, a wrong token, a home that cannot boot and no answer apart", async () => {
  answer(() => new Response("{}", { status: 200 }))
  expect(await probe("t")).toEqual({ kind: "ok" })
  answer(() => new Response("unauthorized", { status: 401 }))
  expect(await probe("t")).toEqual({ kind: "unauthorized" })
  answer(() => new Response(JSON.stringify({ error: "boot_failed", failure: "bad row" }), { status: 503 }))
  expect(await probe("t")).toEqual({ kind: "boot_failed", failure: "bad row" })
  answer(() => new Response("bad gateway", { status: 502 }))
  expect(await probe("t")).toEqual({ kind: "unreachable" })
  answer(() => Promise.reject(new TypeError("network down")))
  expect(await probe("t")).toEqual({ kind: "unreachable" })
})

test("only a 503 means the home cannot boot; a 500 that names a failure is still no answer", async () => {
  answer(() => new Response(JSON.stringify({ error: "internal", failure: "worker threw" }), { status: 500 }))
  expect(await probe("t")).toEqual({ kind: "unreachable" })
})
