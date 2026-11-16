import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import "@earendil-works/pi-ai/api/openai-completions"
import { describe, expect, it } from "vitest"
import { cmd as call, fresh } from "../../test/support.ts"
import { WIDE_MODEL } from "../../test/plugins/m3.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { scrub } from "./health.ts"

type Stub = ReturnType<typeof fresh>
type ProviderRow = { id: string; health: { state: string; failures: number; error?: string } | null }

async function healthOf(stub: Stub, id: string, provider: string): Promise<ProviderRow["health"] | undefined> {
  const catalog = await call(stub, id, "models.catalog", {})
  return (catalog.result as { providers: ProviderRow[] }).providers.find((row) => row.id === provider)?.health
}

async function withFetch<T>(
  reply: (url: string, auth: string, request: Request) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return reply(request.url, request.headers.get("authorization") ?? "", request)
  }
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const hang = (request: Request): Promise<Response> =>
  new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
  })

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
    const turn = async (id: string): Promise<void> => {
      await runInDurableObject(stub, async (home: Home) => {
        home.script(["error:401 token local-dev-tok is not valid"])
        await home.submit("again", id)
        await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      })
    }
    await evictDurableObject(stub)
    await turn("short-key-evicted")
    expect((await healthOf(stub, "short-key-evicted-health", FAUX_MODEL.provider))?.error).toBe(
      "401 token [redacted] is not valid",
    )
    expect((await call(stub, "short-key-delete", "credential.delete", { provider: FAUX_MODEL.provider })).ok).toBe(true)
    await turn("short-key-deleted")
    expect((await healthOf(stub, "short-key-deleted-health", FAUX_MODEL.provider))?.error).toBe(
      "401 token local-dev-tok is not valid",
    )
  })

  it("gives the whole test one deadline, the endpoint's model listing included", async () => {
    const stub = fresh()
    const endpoint = { api: "openai-completions" }
    await withFetch(listing, () =>
      call(stub, "deadline-stored", "credential.set", {
        provider: "slow",
        custom: { ...endpoint, baseUrl: "https://slow.test/v1", key: "slow-key" },
      }),
    )
    const started = Date.now()
    const [listed, chatted] = await withFetch(
      (url, _auth, request) =>
        url.startsWith("https://hang.test") ? hang(request) : url.endsWith("/models") ? listing() : hang(request),
      () =>
        Promise.all([
          call(stub, "deadline-set", "credential.set", {
            provider: "hang",
            custom: { ...endpoint, baseUrl: "https://hang.test/v1", key: "hang-key" },
            test: true,
          }),
          call(stub, "deadline-test", "credential.test", { provider: "slow" }),
        ]),
    )
    expect(Date.now() - started).toBeLessThan(25_000)
    expect(listed).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(chatted).toMatchObject({ ok: true, result: { ok: false } })
  }, 40_000)

  it("sends a session id with every probe, as OpenCode requires", async () => {
    const stub = fresh()
    expect((await call(stub, "session-key", "credential.set", { provider: "opencode", key: "oc-key" })).ok).toBe(true)
    const sessions: (string | null)[] = []
    await withFetch(
      (url, _auth, request) => {
        if (!url.endsWith("/models")) sessions.push(request.headers.get("x-opencode-session"))
        return new Response("{}", { status: 401 })
      },
      () => call(stub, "session-test", "credential.test", { provider: "opencode" }),
    )
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("probes the owner's default before a favourite, whatever the catalog order", async () => {
    const stub = fresh()
    const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
    for (const [index, [chosen, favourite]] of [
      [narrow, WIDE_MODEL],
      [WIDE_MODEL, narrow],
    ].entries()) {
      expect((await call(stub, `pref-default-${index}`, "owner.defaults", { role: "chat", model: chosen })).ok).toBe(
        true,
      )
      expect((await call(stub, `pref-fav-${index}`, "models.favorite", { model: favourite, favorite: true })).ok).toBe(
        true,
      )
      expect(
        await call(stub, `pref-test-${index}`, "credential.test", { provider: WIDE_MODEL.provider }),
      ).toMatchObject({ ok: true, result: { model: chosen } })
      expect(
        (await call(stub, `pref-unfav-${index}`, "models.favorite", { model: favourite, favorite: false })).ok,
      ).toBe(true)
    }
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
    const key = "faux-tok-1"
    for (const form of [btoa(key).replace(/=+$/, ""), btoa(`u:${key}`), btoa(`${key}:`), btoa(`ab:${key}:x`)]) {
      const clean = scrub(`401 Basic ${form} bad`, [key])
      expect(clean, form).toContain("[redacted]")
      expect(clean, form).not.toContain(form.slice(3, -3))
    }
    expect(scrub("401 tok\u2011abc123 refused", ["tok\u2011abc123"])).toBe("401 [redacted] refused")
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
