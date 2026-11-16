import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { AgentDoc, type ConversationId, LiveDoc } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd as call, eventually, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home, TEXT_ONLY_MODEL } from "../../test/worker.ts"
import { FALLBACK_KIND } from "./fallback.ts"

const context = BACKGROUND_CONTEXT
type Stub = ReturnType<typeof fresh>

const rootId = async (home: Home): Promise<ConversationId> => (await home.root()).id as ConversationId

async function stateOf(home: Home) {
  {
    const id = await rootId(home)
    const live = await home.harness.snapshot(LiveDoc, id, context)
    const agent = await home.harness.snapshot(AgentDoc, id, context)
    const conversation = await home.harness.conversation(id, context)
    const entries = (await conversation?.entries({ order: "ascending" }, 100, undefined, context))?.items ?? []
    return {
      busy: live?.run !== undefined,
      failure: live?.runFailure,
      model: agent?.model,
      notes: entries.filter((entry) => entry.kind === FALLBACK_KIND).map((entry) => entry.data),
    }
  }
}

const state = (stub: Stub) => runInDurableObject(stub, stateOf)

async function send(stub: Stub, responses: readonly string[], requestId: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    home.script(responses)
    await home.chooseModel(FAUX_MODEL)
    await home.submit("hello", requestId)
  })
}

describe("model fallbacks", () => {
  it("moves a failed run to the next fallback and answers there", async () => {
    const stub = fresh()
    expect(await call(stub, "fb-set", "owner.fallbacks.set", { models: [FAUX_MODEL, TEXT_ONLY_MODEL] })).toMatchObject({
      ok: true,
      result: { models: [FAUX_MODEL, TEXT_ONLY_MODEL] },
    })
    await send(stub, ["error:provider exploded", "recovered"], "fb-run")
    await eventually(stub, async (home: Home) => {
      const now = await stateOf(home)
      return !now.busy && now.notes.length === 1
    })
    const now = await state(stub)
    expect(now.model).toEqual(TEXT_ONLY_MODEL)
    expect(now.failure).toBeUndefined()
    expect(now.notes).toEqual([{ from: FAUX_MODEL, to: TEXT_ONLY_MODEL, error: "provider exploded" }])
    expect(await call(stub, "fb-read", "owner.fallbacks", {})).toMatchObject({
      result: { models: [FAUX_MODEL, TEXT_ONLY_MODEL] },
    })
  })

  it("tries each fallback once per failure streak, then lets the run fail", async () => {
    const stub = fresh()
    expect((await call(stub, "fb-loop-set", "owner.fallbacks.set", { models: [TEXT_ONLY_MODEL, FAUX_MODEL] })).ok).toBe(
      true,
    )
    await send(stub, ["error:provider exploded", "error:provider exploded", "unused"], "fb-loop")
    await eventually(stub, async (home: Home) => {
      const now = await stateOf(home)
      return !now.busy && now.failure !== undefined && now.notes.length === 1
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const now = await state(stub)
    expect(now.notes).toHaveLength(1)
    expect(now.model).toEqual(TEXT_ONLY_MODEL)
    expect(now.failure).toMatchObject({ reason: "model_error" })
  })

  it("leaves a failed run alone with no fallbacks set", async () => {
    const stub = fresh()
    await send(stub, ["error:provider exploded"], "fb-none")
    await eventually(stub, async (home: Home) => (await stateOf(home)).failure !== undefined)
    const now = await state(stub)
    expect(now.model).toEqual(FAUX_MODEL)
    expect(now.notes).toEqual([])
  })

  it("refuses an unknown fallback model", async () => {
    const stub = fresh()
    expect(
      await call(stub, "fb-bad", "owner.fallbacks.set", { models: [{ provider: "nope", modelId: "x" }] }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })
})
