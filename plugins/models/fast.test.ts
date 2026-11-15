import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { cmd as call, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { FastDoc, fastPayload } from "./fast.ts"

const OPENAI = { provider: "openai", modelId: "gpt-5.4" }

type Entry = { provider: string; modelId: string; modes: string[] }

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
    const stub = fresh()
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
    expect(await stored()).toEqual({ on: true })
    expect(await call(stub, "fast-switch", "conv.configure", { model: FAUX_MODEL })).toMatchObject({
      ok: true,
      result: { fast: false },
    })
    expect(await stored()).toEqual({ on: false })
  })

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
