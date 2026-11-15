import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable"
import { arr, bool, compile, num, obj, oneOf, str, union, lit, type Static } from "@earendil-works/pi-schema"
import { describe, expect, it } from "vitest"
import { FEATURES } from "../../src/contracts/models.ts"
import type { CommandId } from "../../src/ids.ts"
import { addThreads, cmd as call, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const Amount = obj({ spend: num(), tokens: num() })
const Nullable = union([num(), lit(null)])
const BreakdownSchema = obj({
  features: arr(
    obj({
      feature: oneOf(FEATURES),
      today: Amount,
      month: Amount,
      cap: obj({ day: Nullable, month: Nullable }),
      capped: bool(),
    }),
  ),
  byModel: arr(obj({ feature: oneOf(FEATURES), provider: str(), modelId: str(), spend: num(), tokens: num() })),
})
const breakdownCheck = compile(BreakdownSchema)
type Breakdown = Static<typeof BreakdownSchema>

async function breakdown(stub: Stub, id: string): Promise<Breakdown> {
  const reply = await call(stub, id, "usage.features", {})
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  if (!breakdownCheck.check(reply.result)) throw new Error(`malformed breakdown ${JSON.stringify(reply.result)}`)
  return reply.result
}

/** Rows written into the feature ledger itself, index entries included. */
const writes = (home: Home): number =>
  Object.entries(home.meter().statements)
    .filter(([sql]) => sql.includes("usage_feature"))
    .reduce((sum, [, bucket]) => sum + bucket.writes, 0)

const line = (found: Breakdown, feature: string) => found.features.find((entry) => entry.feature === feature)

function bill(home: Home, conversation: ConversationId, key: string, tokens: number, cost: number): Promise<void> {
  return home.harness.commit(async (tx) => {
    const models = (await tx.doc(UsageDoc, conversation)).models
    if (!Object.hasOwn(models, key))
      models[key] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }
    const usage = models[key]
    if (usage === undefined) return
    usage.input += tokens
    usage.totalTokens += tokens
    usage.cost.input += cost
    usage.cost.total += cost
  }, context)
}

describe("usage by feature", () => {
  it("books chat, thread and charged Dreamer spend under their own feature and model", async () => {
    const stub = fresh()
    const created = await call(stub, "feature-project", "project.create", { slug: "ledger", name: "Ledger" })
    const project = created.result as { id: string }
    const [thread] = await addThreads(stub, project.id, ["worker"])
    if (thread === undefined) throw new Error("no thread")
    const root = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
    await runInDurableObject(stub, async (home: Home) => {
      await bill(home, root, "faux/faux-1", 100, 0.5)
      await bill(home, thread.id, "faux/faux-1", 40, 0.25)
      const answer = fauxAssistantMessage("dreamt")
      await home.loader.ctx.models.charge("dreamer", root, {
        ...answer,
        provider: "faux",
        model: "faux-1",
        usage: { ...answer.usage, input: 7, totalTokens: 7, cost: { ...answer.usage.cost, input: 0.1, total: 0.1 } },
      })
    })
    const found = await breakdown(stub, "feature-read-1")
    expect(line(found, "chat")?.today).toEqual({ spend: 0.5, tokens: 100 })
    expect(line(found, "thread")?.month).toEqual({ spend: 0.25, tokens: 40 })
    expect(line(found, "dreamer")?.today).toEqual({ spend: 0.1, tokens: 7 })
    expect(found.byModel).toContainEqual({
      feature: "dreamer",
      provider: "faux",
      modelId: "faux-1",
      spend: 0.1,
      tokens: 7,
    })

    const again = await breakdown(stub, "feature-read-2")
    expect(line(again, "chat")?.today).toEqual({ spend: 0.5, tokens: 100 })

    const cost = await call(stub, "feature-cost", "usage.cost", { convs: [thread.id, root] })
    expect(cost).toMatchObject({ ok: true, result: { spend: 0.85, tokens: 147 } })
    expect(cost.result).toMatchObject({
      conversations: [
        { conv: thread.id, spend: 0.25, tokens: 40 },
        { conv: root, spend: 0.6, tokens: 107 },
      ],
    })
  }, 30_000)

  it("refuses work for a capped feature where it starts and lets the other features run", async () => {
    const stub = fresh()
    expect(await call(stub, "cap-chat", "usage.feature.cap.set", { feature: "chat", day: 0 })).toMatchObject({
      ok: true,
      result: { feature: "chat", cap: { day: 0, month: null } },
    })
    expect(await call(stub, "cap-msg", "message.send", { text: "over the chat cap", clientTs: 1 })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    })
    await runInDurableObject(stub, async (home: Home) => {
      expect(await home.loader.ctx.models.admit("dreamer")).toEqual({ kind: "ok" })
      expect(await home.loader.ctx.models.admitConversation((await home.root()).id)).toMatchObject({
        kind: "capped",
        feature: "chat",
        period: "day",
      })
    })
    expect(line(await breakdown(stub, "cap-read"), "chat")).toMatchObject({ capped: true, cap: { day: 0 } })

    await call(stub, "cap-clear", "usage.feature.cap.set", { feature: "chat", day: null })
    expect(await call(stub, "cap-msg-2", "message.send", { text: "under no cap", clientTs: 2 })).toMatchObject({
      ok: true,
    })
  }, 30_000)

  it("writes one ledger row per changed feature and model in a flush, and none when nothing moved", async () => {
    const stub = fresh()
    await breakdown(stub, "rows-seed")
    const changed = await runInDurableObject(stub, async (home: Home) => {
      const root = (await home.root()).id
      await bill(home, root, "faux/faux-1", 10, 0.01)
      await bill(home, root, "dreamer:faux/faux-1", 5, 0.01)
      const before = writes(home)
      await home.commands.run(
        { id: crypto.randomUUID() as CommandId, op: "usage.features", args: {} },
        { kind: "owner" },
      )
      return writes(home) - before
    })
    const idle = await runInDurableObject(stub, async (home: Home) => {
      const before = writes(home)
      await home.commands.run(
        { id: crypto.randomUUID() as CommandId, op: "usage.features", args: {} },
        { kind: "owner" },
      )
      return writes(home) - before
    })
    expect(changed).toBe(2)
    expect(idle).toBe(0)
  })
})
