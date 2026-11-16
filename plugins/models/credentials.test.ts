import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { describe, expect, it } from "vitest"
import { cmd as call, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { scrub } from "./health.ts"

type Stub = ReturnType<typeof fresh>
type ProviderRow = { id: string; health: { state: string; failures: number; error?: string } | null }

async function healthOf(stub: Stub, id: string, provider: string): Promise<ProviderRow["health"] | undefined> {
  const catalog = await call(stub, id, "models.catalog", {})
  return (catalog.result as { providers: ProviderRow[] }).providers.find((row) => row.id === provider)?.health
}

async function withFetch<T>(reply: (url: string, auth: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return reply(request.url, request.headers.get("authorization") ?? "")
  }
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const listing = () =>
  new Response(JSON.stringify({ object: "list", data: [{ id: "gate-1", object: "model" }] }), {
    headers: { "content-type": "application/json" },
  })

describe("credential checks", () => {
  it("tests a provider with one tiny request and records its health", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => home.script(["OK"]))
    expect(await healthOf(stub, "health-before", FAUX_MODEL.provider)).toBeNull()
    const passed = await call(stub, "test-pass", "credential.test", { provider: FAUX_MODEL.provider })
    expect(passed).toMatchObject({ ok: true, result: { ok: true, provider: FAUX_MODEL.provider } })
    expect(await healthOf(stub, "health-ok", FAUX_MODEL.provider)).toMatchObject({ state: "ok", failures: 0 })

    await runInDurableObject(stub, async (home: Home) => home.script(["error:401 invalid x-api-key"]))
    const failed = await call(stub, "test-fail", "credential.test", {
      provider: FAUX_MODEL.provider,
      model: FAUX_MODEL.modelId,
    })
    expect(failed).toMatchObject({
      ok: true,
      result: { ok: false, model: FAUX_MODEL, error: "401 invalid x-api-key" },
    })
    expect(await healthOf(stub, "health-fail", FAUX_MODEL.provider)).toMatchObject({
      state: "failing",
      failures: 1,
      error: "401 invalid x-api-key",
    })
  })

  it("answers a provider with no stored key without a request", async () => {
    const stub = fresh()
    expect(await call(stub, "test-none", "credential.test", { provider: "nobody" })).toMatchObject({
      ok: true,
      result: { ok: false, error: "no nobody model is unlocked by a stored key" },
    })
  })

  it("records health from conversation turns", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["hello back"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "health-turn")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    })
    expect(await healthOf(stub, "health-turn-read", FAUX_MODEL.provider)).toMatchObject({ state: "ok" })
  })

  it("refuses to save a key whose test fails and keeps nothing behind", async () => {
    const stub = fresh()
    const rejected = await withFetch(
      (url) => (url.endsWith("/models") ? listing() : new Response('{"error":"bad key"}', { status: 401 })),
      () =>
        call(stub, "set-tested", "credential.set", {
          provider: "gate",
          custom: { baseUrl: "https://gate.test/v1", key: "wrong", api: "openai-completions" },
          test: true,
        }),
    )
    expect(rejected).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(JSON.stringify(rejected)).toContain("the key was not saved")
    const providers = (await call(stub, "set-tested-read", "models.catalog", {})).result as { providers: ProviderRow[] }
    expect(providers.providers.some((row) => row.id === "gate")).toBe(false)
  }, 15_000)

  it("saves a key whose test passes and records the provider healthy", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => home.script(["OK"]))
    const saved = await call(stub, "set-pass", "credential.set", {
      provider: FAUX_MODEL.provider,
      key: "faux-key",
      test: true,
    })
    expect(saved).toMatchObject({ ok: true, result: { provider: FAUX_MODEL.provider, test: { ok: true } } })
    expect(await healthOf(stub, "set-pass-health", FAUX_MODEL.provider)).toMatchObject({ state: "ok" })
  })

  it("keeps the previous key when a tested key fails, and never echoes the key", async () => {
    const stub = fresh()
    const endpoint = { baseUrl: "https://gate.test/v1", api: "openai-completions" }
    const leaked = "sk-SECRET-1234567890abcdef"
    await withFetch(listing, () =>
      call(stub, "set-old", "credential.set", { provider: "gate", custom: { ...endpoint, key: "good-key" } }),
    )
    const rejected = await withFetch(
      (url) => (url.endsWith("/models") ? listing() : new Response(`{"error":"bad key ${leaked}"}`, { status: 401 })),
      () =>
        call(stub, "set-new", "credential.set", { provider: "gate", custom: { ...endpoint, key: leaked }, test: true }),
    )
    expect(rejected).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(JSON.stringify(rejected)).not.toContain(leaked)
    expect(await healthOf(stub, "set-new-health", "gate")).toBeNull()
    const used: string[] = []
    await withFetch(
      (url, auth) => {
        if (!url.endsWith("/models")) used.push(auth)
        return url.endsWith("/models") ? listing() : new Response("{}", { status: 401 })
      },
      () => call(stub, "test-old", "credential.test", { provider: "gate" }),
    )
    expect(used).toEqual(["Bearer good-key"])
  })

  it("keeps a stored key that is not key-shaped out of health from a turn", async () => {
    const stub = fresh()
    expect(
      (await call(stub, "short-key", "credential.set", { provider: FAUX_MODEL.provider, key: "local-dev-tok" })).ok,
    ).toBe(true)
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["error:401 token local-dev-tok is not valid"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "short-key-turn")
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    })
    expect(await healthOf(stub, "short-key-health", FAUX_MODEL.provider)).toMatchObject({
      state: "failing",
      error: "401 token [redacted] is not valid",
    })
  })

  it("redacts whole key-shaped words but leaves model and request ids readable", () => {
    expect(
      scrub(
        "404 The model meta-llama-3-1-405b-instruct-turbo-fp8 does not exist (request 3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c)",
        [],
      ),
    ).toBe(
      "404 The model meta-llama-3-1-405b-instruct-turbo-fp8 does not exist (request 3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c)",
    )
    expect(scrub("429 rate limit on task_queue_overloaded_error", [])).toBe(
      "429 rate limit on task_queue_overloaded_error",
    )
    expect(scrub("bad key sk-proj-abcdefghijklmnop and AIzaSyA1234567890abcdef", [])).toBe(
      "bad key [redacted] and [redacted]",
    )
    expect(scrub(`Basic ${btoa("tok-1234")}`, ["tok-1234"])).toBe("Basic [redacted]")
  })

  it("refuses endpoints a Worker cannot reach", async () => {
    const stub = fresh()
    for (const baseUrl of [
      "http://api.example.com/v1",
      "https://localhost:11434/v1",
      "https://localhost./v1",
      "https://a.localhost/v1",
      "https://box.local./v1",
      "https://192.168.1.4/v1",
      "https://100.64.1.1/v1",
      "https://0.1.2.3/v1",
      "https://198.18.0.1/v1",
      "https://224.0.0.1/v1",
    ])
      expect(
        await call(stub, `set-${baseUrl}`, "credential.set", {
          provider: "local",
          custom: { baseUrl, key: "k", api: "openai-completions" },
        }),
        baseUrl,
      ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })
})
