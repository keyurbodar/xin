import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { AgentDoc, type ConversationId, LiveDoc } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd as call, eventually, fresh } from "../../test/support.ts"
import { DREAM_MODEL, requests as dreamRequests, script as scriptDream } from "../../test/plugins/m7.ts"
import { FAUX_MODEL, type Home, TEXT_ONLY_MODEL } from "../../test/worker.ts"
import { FALLBACK_KIND, wantsFallback } from "./fallback.ts"

const context = BACKGROUND_CONTEXT
type Stub = ReturnType<typeof fresh>
const failed = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage })

async function stateOf(home: Home) {
  const id = (await home.root()).id as ConversationId
  const live = await home.harness.snapshot(LiveDoc, id, context)
  const agent = await home.harness.snapshot(AgentDoc, id, context)
  const conversation = await home.harness.conversation(id, context)
  const entries = (await conversation?.entries({ order: "ascending" }, 100, undefined, context))?.items ?? []
  const last = entries.findLast((entry) => entry.model?.[0]?.role === "assistant")?.model?.[0]
  return {
    busy: live?.run !== undefined,
    failure: live?.runFailure,
    model: agent?.model,
    answer: last?.role === "assistant" && last.stopReason === "stop" ? last.content : undefined,
    notes: entries.filter((entry) => entry.kind === FALLBACK_KIND).map((entry) => entry.data),
  }
}

async function send(stub: Stub, responses: readonly string[], requestId: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    home.script(responses)
    await home.chooseModel(FAUX_MODEL)
    await home.submit("hello", requestId)
  })
}

describe("model fallbacks", () => {
  it("answers the failing run on the next capable fallback, without a run failure", async () => {
    const stub = fresh()
    dreamRequests.length = 0
    scriptDream([fauxAssistantMessage("fallback answer")])
    expect(await call(stub, "fb-set", "owner.fallbacks.set", { models: [TEXT_ONLY_MODEL, DREAM_MODEL] })).toMatchObject(
      { ok: true, result: { models: [TEXT_ONLY_MODEL, DREAM_MODEL] } },
    )
    await send(stub, ["error:401 invalid x-api-key"], "fb-run")
    await eventually(stub, async (home: Home) => {
      const now = await stateOf(home)
      return !now.busy && now.answer !== undefined
    })
    const now = await runInDurableObject(stub, stateOf)
    expect(now.failure).toBeUndefined()
    expect(now.model).toEqual(DREAM_MODEL)
    expect(JSON.stringify(now.answer)).toContain("fallback answer")
    expect(now.notes).toEqual([{ from: FAUX_MODEL, to: DREAM_MODEL, error: "401 invalid x-api-key" }])
    expect(dreamRequests).toHaveLength(1)
  })

  it("lets a request fault fail the run on its own model", async () => {
    const stub = fresh()
    dreamRequests.length = 0
    expect((await call(stub, "fb-400-set", "owner.fallbacks.set", { models: [DREAM_MODEL] })).ok).toBe(true)
    await send(stub, ["error:400 invalid_request_error: messages.0.content is required"], "fb-400")
    await eventually(stub, async (home: Home) => (await stateOf(home)).failure !== undefined)
    const now = await runInDurableObject(stub, stateOf)
    expect(now.failure).toMatchObject({ reason: "model_error" })
    expect(now.model).toEqual(FAUX_MODEL)
    expect(now.notes).toEqual([])
    expect(dreamRequests).toHaveLength(0)
  })

  it("leaves a failed run alone with no fallbacks set", async () => {
    const stub = fresh()
    await send(stub, ["error:401 invalid x-api-key"], "fb-none")
    await eventually(stub, async (home: Home) => (await stateOf(home)).failure !== undefined)
    const now = await runInDurableObject(stub, stateOf)
    expect(now.model).toEqual(FAUX_MODEL)
    expect(now.notes).toEqual([])
  })

  it("falls back on account faults at once and on transient faults only at the last retry", () => {
    for (const text of [
      "401 invalid x-api-key",
      "403 Forbidden",
      "insufficient_quota",
      "Your credit balance is too low",
    ])
      expect(wantsFallback(failed(text), 1, 6), text).toBe(true)
    expect(wantsFallback(failed("503 Service Unavailable"), 5, 6)).toBe(false)
    expect(wantsFallback(failed("503 Service Unavailable"), 6, 6)).toBe(true)
    expect(wantsFallback(failed("Could not parse Anthropic SSE event"), 6, 6)).toBe(true)
    expect(wantsFallback(failed("401 invalid x-api-key"), 7, 6)).toBe(false)
    for (const text of [
      "400 invalid_request_error: messages.0.content is required",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "provider exploded",
    ])
      expect(wantsFallback(failed(text), 1, 6), text).toBe(false)
    expect(wantsFallback(fauxAssistantMessage("fine"), 1, 6)).toBe(false)
  })

  it("refuses an unknown fallback model", async () => {
    const stub = fresh()
    expect(
      await call(stub, "fb-bad", "owner.fallbacks.set", { models: [{ provider: "nope", modelId: "x" }] }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })
})
