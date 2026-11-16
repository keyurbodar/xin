import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable"
import { arr, bool, compile, num, obj, oneOf, str, union, lit, type Static } from "@earendil-works/pi-schema"
import { describe, expect, it } from "vitest"
import { FEATURES } from "../../src/contracts/models.ts"
import type { CommandId } from "../../src/ids.ts"
import { addThreads, cmd as call, fresh, type Stub } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"

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

function bill(
  home: Home,
  conversation: ConversationId,
  key: string,
  tokens: number,
  cost: number,
  bucket: "models" | "tools" = "models",
): Promise<void> {
  return home.harness.commit(async (tx) => {
    const models = (await tx.doc(UsageDoc, conversation))[bucket]
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
      await home.services.models.charge("dreamer", root, {
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
      expect(await home.services.models.admit("dreamer")).toEqual({ kind: "ok" })
      expect(await home.services.models.admitConversation((await home.root()).id)).toMatchObject({
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

  it("sums every conversation's models and tools into the features, with unlisted spend under other", async () => {
    const stub = fresh()
    await breakdown(stub, "sum-seed")
    const created = await call(stub, "sum-project", "project.create", { slug: "sum", name: "Sum" })
    const project = created.result as { id: string; coordinatorId: number }
    const [thread] = await addThreads(stub, project.id, ["summer"])
    if (thread === undefined) throw new Error("no thread")
    const puck = (await call(stub, "sum-puck", "puck.create", { title: "side chat" })).result as { id: string }
    await runInDurableObject(stub, async (home: Home) => {
      const root = (await home.root()).id
      const loose = await home.harness.createConversation({ ownership: { kind: "ownerless" } }, context)
      await bill(home, root, "faux/faux-1", 100, 0.5)
      await bill(home, Number(puck.id) as ConversationId, "faux/faux-1", 30, 0.2)
      await bill(home, project.coordinatorId as ConversationId, "faux/faux-1", 20, 0.1)
      await bill(home, thread.id as ConversationId, "faux/faux-1", 40, 0.25)
      await bill(home, thread.id as ConversationId, "web_search", 5, 0.05, "tools")
      await bill(home, loose.id, "faux/faux-1", 9, 0.07)
    })
    const found = await breakdown(stub, "sum-read")
    expect(line(found, "chat")?.today).toEqual({ spend: 0.8, tokens: 150 })
    expect(line(found, "thread")?.today).toEqual({ spend: 0.3, tokens: 45 })
    expect(line(found, "other")?.today).toEqual({ spend: 0.07, tokens: 9 })
    expect(found.byModel).toContainEqual({
      feature: "thread",
      provider: "tool",
      modelId: "web_search",
      spend: 0.05,
      tokens: 5,
    })
    const summary = await call(stub, "sum-summary", "usage.summary", {})
    const today = (summary.result as { today: { spend: number; tokens: number } }).today
    const features = found.features.reduce(
      (sum, entry) => ({ spend: sum.spend + entry.today.spend, tokens: sum.tokens + entry.today.tokens }),
      { spend: 0, tokens: 0 },
    )
    expect(features.tokens).toBe(today.tokens)
    expect(features.spend).toBeCloseTo(today.spend, 9)
  }, 30_000)

  it("books a chat running an armed goal as goal", async () => {
    const stub = fresh()
    const root = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
    expect(
      await call(stub, "goal-root", "goal.set", { conversation: root, action: "create", objective: "ship it" }),
    ).toMatchObject({ ok: true })
    await call(stub, "goal-cap", "usage.feature.cap.set", { feature: "goal", day: 0 })
    await runInDurableObject(stub, async (home: Home) => {
      expect(await home.services.models.admitConversation(root)).toMatchObject({ kind: "capped", feature: "goal" })
    })
  }, 30_000)

  it("refuses a thread start once unflushed spend in the running loop passes the cap", async () => {
    const stub = fresh()
    const created = await call(stub, "loop-project", "project.create", { slug: "loop", name: "Loop" })
    const project = created.result as { id: string; coordinatorId: number }
    const [thread] = await addThreads(stub, project.id, ["looper"])
    if (thread === undefined) throw new Error("no thread")
    await call(stub, "loop-model", "conv.configure", { conv: project.coordinatorId, model: FAUX_MODEL })
    await call(stub, "loop-default", "owner.defaults", { role: "thread", model: FAUX_MODEL })
    await call(stub, "loop-cap", "usage.feature.cap.set", { feature: "thread", day: 1 })
    await breakdown(stub, "loop-seed")
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      await bill(home, thread.id as ConversationId, "faux/faux-1", 500, 1.5)
      const before = writes(home)
      const refused = await home.loader.ctx.threads.delegate(
        { conversationId: project.coordinatorId as ConversationId, taskId: "loop-task" },
        { task: "more", title: "more", mode: "async", clientRequestId: "loop-delegate" },
        context,
      )
      return { refused, written: writes(home) - before }
    })
    expect(outcome.refused).toMatchObject({ kind: "rejected" })
    expect(outcome.written).toBe(0)
  }, 30_000)

  it("refuses thread.create and thread.side at a thread cap of 0", async () => {
    const stub = fresh()
    const created = await call(stub, "side-project", "project.create", { slug: "side", name: "Side" })
    const project = created.result as { id: string; coordinatorId: number }
    await call(stub, "side-model", "conv.configure", { conv: project.coordinatorId, model: FAUX_MODEL })
    await call(stub, "side-cap", "usage.feature.cap.set", { feature: "thread", day: 0 })
    expect(
      await call(stub, "side-create", "thread.create", { title: "t", task: "do it", project: project.id }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(
      await call(stub, "side-side", "thread.side", { conv: project.coordinatorId, title: "t", task: "do it" }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } })
    const [thread] = await addThreads(stub, project.id, ["sender"])
    if (thread === undefined) throw new Error("no thread")
    expect(
      await call(stub, "side-send", "thread.send", { threadId: thread.id, text: "again", mode: "queue" }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await call(stub, "side-uncap", "usage.feature.cap.set", { feature: "thread", day: null })
    expect(
      await call(stub, "side-create-2", "thread.create", { title: "t", task: "do it", project: project.id }),
    ).toMatchObject({ ok: true })
  }, 30_000)

  it("books growth once when two flushes overlap", async () => {
    const stub = fresh()
    await breakdown(stub, "overlap-seed")
    await runInDurableObject(stub, async (home: Home) => {
      await bill(home, (await home.root()).id, "faux/faux-1", 10, 1)
      const run = () =>
        home.commands.run({ id: crypto.randomUUID() as CommandId, op: "usage.features", args: {} }, { kind: "owner" })
      await Promise.all([run(), run(), run()])
    })
    const found = await breakdown(stub, "overlap-read")
    expect(line(found, "chat")?.today).toEqual({ spend: 1, tokens: 10 })
    const stored = await runInDurableObject(stub, (home: Home) =>
      home.db.all<{ spend: number }>("SELECT spend FROM usage_feature WHERE feature = 'chat'"),
    )
    expect(stored.reduce((sum, row) => sum + row.spend, 0)).toBe(1)
  }, 30_000)

  it("keeps the month's feature totals across an eviction without scanning the feature ledger", async () => {
    const stub = fresh()
    await breakdown(stub, "boot-seed")
    await runInDurableObject(stub, async (home: Home) => {
      await bill(home, (await home.root()).id, "faux/faux-1", 12, 0.3)
    })
    await breakdown(stub, "boot-flush")
    await evictDurableObject(stub)
    const scans = await runInDurableObject(stub, (home: Home) =>
      Object.entries(home.meter().statements)
        .filter(([sql]) => sql.includes("FROM usage_feature"))
        .reduce((sum, [, bucket]) => sum + bucket.calls, 0),
    )
    expect(scans).toBe(0)
    const today = await call(stub, "boot-today", "usage.today", {})
    expect(today).toMatchObject({ ok: true })
    const chat = (today.result as { features: { feature: string; today: unknown; month: unknown }[] }).features.find(
      (entry) => entry.feature === "chat",
    )
    expect(chat?.today).toEqual({ spend: 0.3, tokens: 12 })
    expect(chat?.month).toEqual({ spend: 0.3, tokens: 12 })
  }, 30_000)
})
