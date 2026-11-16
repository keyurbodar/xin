import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { describe, expect, it } from "vitest"
import { cmd as call, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
type ProviderRow = { id: string; health: { state: string; failures: number; error?: string } | null }

async function healthOf(stub: Stub, id: string, provider: string): Promise<ProviderRow["health"] | undefined> {
  const catalog = await call(stub, id, "models.catalog", {})
  return (catalog.result as { providers: ProviderRow[] }).providers.find((row) => row.id === provider)?.health
}

async function withFetch<T>(reply: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL) =>
    reply(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
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
  })

  it("refuses endpoints a Worker cannot reach", async () => {
    const stub = fresh()
    for (const baseUrl of ["http://api.example.com/v1", "https://localhost:11434/v1", "https://192.168.1.4/v1"])
      expect(
        await call(stub, `set-${baseUrl}`, "credential.set", {
          provider: "local",
          custom: { baseUrl, key: "k", api: "openai-completions" },
        }),
        baseUrl,
      ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })
})
