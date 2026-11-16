import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { cmd as call, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { FastDoc, fastPayload } from "./fast.ts"

const OPENAI = { provider: "openai", modelId: "gpt-5.4" }
const OPENAI_OTHER = { provider: "openai", modelId: "gpt-5.2" }

type Entry = { provider: string; modelId: string; modes: string[] }

/** conv.configure refuses a model with no key, so a test that runs on OpenAI stores one first. */
async function keyed(): Promise<ReturnType<typeof fresh>> {
  const stub = fresh()
  expect((await call(stub, "openai-key", "credential.set", { provider: "openai", key: "sk-test" })).ok).toBe(true)
  return stub
}

describe("fast mode", () => {
  it("lists fast only on models whose provider has a faster tier", async () => {
    const stub = fresh()
    const read = async (id: string, args: object) =>
      ((await call(stub, id, "models.catalog", args)).result as { models: Entry[] }).models
    const openai = await read("fast-openai", { provider: OPENAI.provider })
    const models = [...openai, ...(await read("fast-faux", { provider: FAUX_MODEL.provider }))]
    expect(openai.length).toBeGreaterThan(0)
    expect(
      models.find((model) => model.provider === OPENAI.provider && model.modelId === OPENAI.modelId)?.modes,
    ).toEqual(["fast"])
    expect(models.find((model) => model.provider === FAUX_MODEL.provider)?.modes).toEqual([])
    expect(models.filter((model) => model.modes.includes("fast")).every((model) => model.provider === "openai")).toBe(
      true,
    )
  })

  it("turns fast on for a model that lists it, refuses it elsewhere, and drops it on a switch to such a model", async () => {
    const stub = await keyed()
    expect(await call(stub, "fast-faux", "conv.configure", { model: FAUX_MODEL, fast: true })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await call(stub, "fast-on", "conv.configure", { model: OPENAI, fast: true })).toMatchObject({
      ok: true,
      result: { model: OPENAI, fast: true },
    })
    const stored = async () =>
      runInDurableObject(stub, async (home: Home) =>
        home.harness.snapshot(FastDoc, (await home.root()).id as ConversationId, BACKGROUND_CONTEXT),
      )
    expect(await stored()).toEqual({ model: OPENAI })
    expect(await call(stub, "fast-switch", "conv.configure", { model: FAUX_MODEL })).toMatchObject({
      ok: true,
      result: { fast: false },
    })
    expect(await stored()).toEqual({ model: null })
  })

  it("writes no fast doc for a conversation that never turned fast on", async () => {
    const stub = await keyed()
    expect((await call(stub, "never-model", "conv.configure", { model: OPENAI })).ok).toBe(true)
    expect((await call(stub, "never-switch", "conv.configure", { model: FAUX_MODEL })).ok).toBe(true)
    expect((await call(stub, "never-off", "conv.configure", { fast: false })).ok).toBe(true)
    const stored = await runInDurableObject(stub, async (home: Home) =>
      home.harness.snapshot(FastDoc, (await home.root()).id as ConversationId, BACKGROUND_CONTEXT),
    )
    expect(stored).toBeUndefined()
  })

  it("clears fast when a disable moves the conversation to a model without it, so switching back keeps it off", async () => {
    const stub = await keyed()
    expect((await call(stub, "move-default", "owner.defaults", { role: "chat", model: FAUX_MODEL })).ok).toBe(true)
    expect(await call(stub, "move-on", "conv.configure", { model: OPENAI, fast: true })).toMatchObject({
      ok: true,
      result: { fast: true },
    })
    const off = await call(stub, "move-off", "models.enable", { model: OPENAI, enabled: false })
    expect(off.ok, JSON.stringify(off)).toBe(true)
    expect(await call(stub, "move-back-on", "models.enable", { model: OPENAI, enabled: true })).toMatchObject({
      ok: true,
    })
    expect(await call(stub, "move-back", "conv.configure", { model: OPENAI })).toMatchObject({
      ok: true,
      result: { model: OPENAI, fast: false },
    })
    const stored = await runInDurableObject(stub, async (home: Home) =>
      home.harness.snapshot(FastDoc, (await home.root()).id as ConversationId, BACKGROUND_CONTEXT),
    )
    expect(stored).toEqual({ model: null })
  })

  it("puts service_tier priority on the wire only while fast is on for the model the request goes to", async () => {
    const stub = await keyed()
    const bodies: Record<string, unknown>[] = []
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("api.openai.com")) {
        const text = input instanceof Request ? await input.text() : String(init?.body ?? "")
        bodies.push(JSON.parse(text) as Record<string, unknown>)
      }
      return Response.json({ error: { message: "stub" } }, { status: 400 })
    }
    try {
      expect((await call(stub, "wire-cred", "credential.set", { provider: "openai", key: "sk-test" })).ok).toBe(true)
      const send = async (fast: boolean, requestId: string): Promise<Record<string, unknown> | undefined> => {
        expect((await call(stub, `${requestId}-cfg`, "conv.configure", { model: OPENAI, fast })).ok).toBe(true)
        const before = bodies.length
        await runInDurableObject(stub, async (home: Home) => {
          const root = await home.root()
          await root.submit({ type: "input", content: "hi", requestId }, BACKGROUND_CONTEXT)
          await root.waitForIdle(BACKGROUND_CONTEXT)
        })
        return bodies[before]
      }
      expect((await send(true, "wire-fast"))?.service_tier).toBe("priority")
      expect(await send(false, "wire-plain")).not.toHaveProperty("service_tier")
      expect((await send(true, "wire-again"))?.service_tier).toBe("priority")
      const before = bodies.length
      await runInDurableObject(stub, async (home: Home) => {
        const root = await home.root()
        await root.configure({ model: OPENAI_OTHER }, BACKGROUND_CONTEXT)
        await root.submit({ type: "input", content: "hi", requestId: "wire-other" }, BACKGROUND_CONTEXT)
        await root.waitForIdle(BACKGROUND_CONTEXT)
      })
      expect(bodies[before]).toMatchObject({ model: OPENAI_OTHER.modelId })
      expect(bodies[before]).not.toHaveProperty("service_tier")
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it("sends OpenAI's priority tier only for a model with fast mode", () => {
    const payload = { model: OPENAI.modelId, input: [] }
    expect(fastPayload({ provider: "openai", api: "openai-responses" }, payload)).toEqual({
      ...payload,
      service_tier: "priority",
    })
    expect(fastPayload({ provider: "opencode", api: "openai-responses" }, payload)).toBeUndefined()
    expect(fastPayload({ provider: "anthropic", api: "anthropic-messages" }, payload)).toBeUndefined()
  })
})
