import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  DEFAULT_COMPACTION_POLICY,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import { arr, bool, compile, int, lit, num, obj, str, union, unknown, type Static } from "@earendil-works/pi-schema"
import { describe, expect, it } from "vitest"
import source from "./models.ts?raw"
import { resolveModel } from "../../src/contracts/models.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import type { Actor } from "../../src/ops.ts"
import { addThreads, api, cmd as call, eventually, field, fresh, owner, turn } from "../../test/support.ts"
import { resetAlt, WIDE_MODEL } from "../../test/plugins/m3.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type ListedModel = {
  provider: string
  modelId: string
  keyed: boolean
  cost: { input: number; output: number }
}
type ListReply = { ok: boolean; result: { models: ListedModel[] } }

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
  return [...page.items]
}

const modelsOf = (entries: readonly EntryRecord[]): { provider: string; model: string }[] =>
  entries
    .filter((entry) => entry.kind === "pi.assistant")
    .flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "assistant" ? [{ provider: message.provider, model: message.model }] : [],
      ),
    )

const textOf = (entry: EntryRecord | undefined): string => {
  const message = entry?.model?.[0]
  if (message === undefined) return ""
  if (typeof message.content === "string") return message.content
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

const firstOf = (entries: readonly EntryRecord[], kind: string): EntryRecord | undefined =>
  entries.find((entry) => entry.kind === kind)

const cmd = (id: string, op: string, args?: unknown) =>
  api("/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }).then((reply) => reply.json())

const custom = (host: string, key: string) => ({ baseUrl: `https://${host}/v1`, key, api: "openai-completions" })

type Slice = {
  readonly name?: string
  readonly provider?: string
  readonly modelId?: string
  readonly totalTokens: number
  readonly cost: number
}
type Dated = { readonly spend: number; readonly tokens: number }
type Project = { readonly id: string; readonly name: string; readonly spend: number; readonly tokens: number }
type Summary = {
  readonly spend: number
  readonly tokens: number
  readonly today: Dated
  readonly month: Dated
  readonly days: readonly (Dated & { readonly day: string })[]
  readonly cap: number | null
  readonly byModel: readonly Slice[]
  readonly byTool: readonly Slice[]
  readonly byProject: readonly Project[]
}

function datedOf(value: unknown): Dated {
  if (typeof value !== "object" || value === null) throw new Error("no dated usage")
  const spend = Reflect.get(value, "spend")
  const tokens = Reflect.get(value, "tokens")
  if (typeof spend !== "number" || typeof tokens !== "number") throw new Error("bad dated usage")
  return { spend, tokens }
}

function sliceOf(value: unknown): Slice {
  if (typeof value !== "object" || value === null) throw new Error("no usage slice")
  const totalTokens = Reflect.get(value, "totalTokens")
  const cost = Reflect.get(value, "cost")
  if (typeof totalTokens !== "number" || typeof cost !== "number") throw new Error("bad usage slice")
  const name = Reflect.get(value, "name")
  const provider = Reflect.get(value, "provider")
  const modelId = Reflect.get(value, "modelId")
  return {
    totalTokens,
    cost,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof modelId === "string" ? { modelId } : {}),
  }
}

function summaryOf(value: unknown): Summary {
  if (typeof value !== "object" || value === null) throw new Error("no usage summary")
  const spend = Reflect.get(value, "spend")
  const tokens = Reflect.get(value, "tokens")
  const byModel = Reflect.get(value, "byModel")
  const byTool = Reflect.get(value, "byTool")
  const cap = Reflect.get(value, "cap")
  if (typeof spend !== "number" || typeof tokens !== "number") throw new Error("bad usage summary")
  return {
    spend,
    tokens,
    today: datedOf(Reflect.get(value, "today")),
    month: datedOf(Reflect.get(value, "month")),
    days: (Array.isArray(Reflect.get(value, "days")) ? Reflect.get(value, "days") : []).flatMap((row: unknown) => {
      if (typeof row !== "object" || row === null) return []
      const day = Reflect.get(row, "day")
      return typeof day === "string" ? [{ ...datedOf(row), day }] : []
    }),
    byModel: Array.isArray(byModel) ? byModel.map(sliceOf) : [],
    byTool: Array.isArray(byTool) ? byTool.map(sliceOf) : [],
    cap: typeof cap === "number" ? cap : null,
    byProject: (Array.isArray(Reflect.get(value, "byProject")) ? Reflect.get(value, "byProject") : []).flatMap(
      (row: unknown) => {
        if (typeof row !== "object" || row === null) return []
        const id = Reflect.get(row, "id")
        const name = Reflect.get(row, "name")
        if (typeof id !== "string" || typeof name !== "string") return []
        return [{ id, name, ...datedOf(row) }]
      },
    ),
  }
}

const ContextSchema = obj({
  conversation: int({ minimum: 0 }),
  model: union([obj({ provider: str(), modelId: str() }), lit(null)]),
  contextWindow: int({ minimum: 0 }),
  used: int({ minimum: 0 }),
  measured: bool(),
  categories: arr(obj({ key: str(), tokens: int({ minimum: 0 }) })),
  compactAt: int({ minimum: 0 }),
})
const contextCheck = compile(ContextSchema)

const readContext = async (stub: ReturnType<typeof fresh>, id: string) => {
  const reply = await call(stub, id, "conv.context", {})
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  if (!contextCheck.check(reply.result)) throw new Error(`bad conv.context result ${JSON.stringify(reply.result)}`)
  return reply.result
}

const postCommand = (op: string, args: object) =>
  api("/v1/cmd", {
    method: "POST",
    body: JSON.stringify({ id: `compaction-rev-${crypto.randomUUID()}`, op, args }),
  })

const compactionsIn = async (home: Home): Promise<number> => {
  const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
  return page.items.filter((entry) => entry.kind === "pi.compaction").length
}

describe("models", () => {
  it("applies a mid-run switch to the next request in the same run", async () => {
    const stub = fresh()
    const entries = await runInDurableObject(stub, async (home: Home) => {
      await home.chooseModel(WIDE_MODEL)
      await home.submit("switch to alt-narrow", "switch-1")
      await home.harness.waitForIdle(context)
      return history(await home.root())
    })
    expect(modelsOf(entries)).toEqual([
      { provider: "faux-alt", model: "alt-wide" },
      { provider: "faux-alt", model: "alt-narrow" },
    ])
    const result = firstOf(entries, "pi.tool-result")
    expect(result).toBeDefined()
    expect(textOf(result)).toContain("alt-narrow")
  })

  it("asks instead of switching when several models match equally", async () => {
    const stub = fresh()
    const entries = await runInDurableObject(stub, async (home: Home) => {
      await home.chooseModel(WIDE_MODEL)
      await home.submit("switch to alt", "switch-2")
      await home.harness.waitForIdle(context)
      const root = await home.root()
      return { entries: await history(root), model: (await root.agent(context)).model }
    })
    expect(modelsOf(entries.entries)).toEqual([
      { provider: "faux-alt", model: "alt-wide" },
      { provider: "faux-alt", model: "alt-wide" },
    ])
    expect(textOf(firstOf(entries.entries, "pi.tool-result"))).toContain("Which model?")
    expect(entries.model).toEqual(WIDE_MODEL)
  })

  it("compacts before the next request when the new window is smaller", async () => {
    const stub = fresh()
    const entries = await runInDurableObject(stub, async (home: Home) => {
      await home.chooseModel(WIDE_MODEL)
      await home.submit("warm up", "switch-3a")
      await home.harness.waitForIdle(context)
      await home.submit(`switch to alt-narrow\n${"turn ".repeat(18_000)}`, "switch-3b")
      await home.harness.waitForIdle(context)
      return history(await home.root())
    })
    const compaction = firstOf(entries, "pi.compaction")
    expect(compaction).toBeDefined()
    expect(compaction?.data).toMatchObject({ reason: "threshold" })
    const answers = modelsOf(entries)
    expect(answers.slice(0, 2)).toEqual([
      { provider: "faux-alt", model: "alt-wide" },
      { provider: "faux-alt", model: "alt-wide" },
    ])
    expect(answers.at(-1)).toEqual({ provider: "faux-alt", model: "alt-narrow" })
    const answer = entries.findLast((entry) => entry.kind === "pi.assistant")
    expect(compaction?.id).toBeLessThan(answer?.id ?? 0)
  }, 30_000)

  it("sums the pi usage ledger for the owner", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("spend one", "usage-1")
      await home.harness.waitForIdle(context)
    })
    const ack = await call(stub, "usage-1", "usage.summary", {})
    expect(ack.ok, JSON.stringify(ack)).toBe(true)
    const summary = summaryOf(ack.result)
    expect(summary.byModel).toHaveLength(1)
    const model = summary.byModel[0]
    expect(model).toMatchObject({ name: "faux/faux-1", provider: "faux", modelId: "faux-1", cost: 0 })
    expect(model?.totalTokens ?? 0).toBeGreaterThan(0)
    expect(summary.byTool).toEqual([])
    expect(summary.tokens).toBe(model?.totalTokens)
    expect(summary.spend).toBe(0)
    expect(summary.today).toEqual({ spend: 0, tokens: summary.tokens })
    expect(summary.month).toEqual({ spend: 0, tokens: summary.tokens })
    const day = new Date().toISOString().slice(0, 10)
    const rows = await runInDurableObject(stub, (home: Home) =>
      home.db.all<{ day: string; spend: number; tokens: number }>("SELECT day, spend, tokens FROM usage_daily"),
    )
    expect(rows).toEqual([{ day, spend: summary.spend, tokens: summary.tokens }])
  })

  it("counts each token once however often the counter runs", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("spend one", "dated-1")
      await home.harness.waitForIdle(context)
    })
    const first = summaryOf((await call(stub, "dated-sum-1", "usage.summary", {})).result)
    const again = summaryOf((await call(stub, "dated-sum-2", "usage.summary", {})).result)
    expect(again.today).toEqual(first.today)

    const day = new Date().toISOString().slice(0, 10)
    const rows = await runInDurableObject(stub, (home: Home) =>
      home.db.all<{ day: string; spend: number; tokens: number }>("SELECT day, spend, tokens FROM usage_daily"),
    )
    expect(rows).toEqual([{ day, spend: 0, tokens: first.tokens }])
    expect(again.days).toEqual([{ day, spend: 0, tokens: first.tokens }])

    await runInDurableObject(stub, async (home: Home) => {
      home.script(["another answer"])
      await home.submit("spend two", "dated-2")
      await home.harness.waitForIdle(context)
    })
    const later = summaryOf((await call(stub, "dated-sum-3", "usage.summary", {})).result)
    expect(later.today.tokens).toBe(later.tokens)
    expect(later.today.tokens).toBeGreaterThan(first.today.tokens)
    expect(later.month.tokens).toBe(later.tokens)
  }, 30_000)

  it("seeds a home that predates the counter instead of booking its history", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("before the counter", "seed-1")
      await home.harness.waitForIdle(context)
      await home.db.run("DELETE FROM kv WHERE key = 'usage.total'")
    })
    const seeded = summaryOf((await call(stub, "seed-sum-1", "usage.summary", {})).result)
    expect(seeded.tokens).toBeGreaterThan(0)
    expect(seeded.today.tokens).toBe(0)
    const rows = await runInDurableObject(stub, (home: Home) =>
      home.db.all<{ day: string }>("SELECT day FROM usage_daily"),
    )
    expect(rows).toEqual([])

    await runInDurableObject(stub, async (home: Home) => {
      home.script(["another answer"])
      await home.submit("after the counter", "seed-2")
      await home.harness.waitForIdle(context)
    })
    const later = summaryOf((await call(stub, "seed-sum-2", "usage.summary", {})).result)
    expect(later.today.tokens).toBeGreaterThan(0)
    expect(later.today.tokens).toBeLessThan(later.tokens)
  }, 30_000)

  it("records a monthly cap and reports it in the summary", async () => {
    const stub = fresh()
    expect((await call(stub, "cap-1", "usage.cap", {})).result).toEqual({ usd: null })
    expect((await call(stub, "cap-2", "usage.cap.set", { usd: 25 })).result).toEqual({ usd: 25 })
    expect(summaryOf((await call(stub, "cap-3", "usage.summary", {})).result).cap).toBe(25)
    expect((await call(stub, "cap-4", "usage.cap.set", { clear: true })).result).toEqual({ usd: null })
    expect((await call(stub, "cap-5", "usage.cap.set", {})).error).toMatchObject({ code: "bad_args" })
  })

  it("notes each spend threshold once a month as the month's total crosses it", async () => {
    const stub = fresh()
    const day = new Date().toISOString().slice(0, 10)
    const now = new Date().toISOString().slice(0, 7)
    const alerted = () =>
      runInDurableObject(stub, (home: Home) =>
        home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'usage.alerted'"),
      )
    await call(stub, "alert-cap", "usage.cap.set", { usd: 10 })
    await runInDurableObject(stub, (home: Home) =>
      home.db.run("INSERT INTO usage_daily (day, spend, tokens) VALUES (?, ?, 1)", day, 8),
    )
    await call(stub, "alert-sum-1", "usage.summary", {})
    expect(JSON.parse((await alerted())?.value ?? "null")).toEqual({ month: now, level: 80 })

    await runInDurableObject(stub, (home: Home) => home.db.run("UPDATE usage_daily SET spend = 11 WHERE day = ?", day))
    await call(stub, "alert-sum-2", "usage.summary", {})
    expect(JSON.parse((await alerted())?.value ?? "null")).toEqual({ month: now, level: 100 })

    await call(stub, "alert-sum-3", "usage.summary", {})
    expect(JSON.parse((await alerted())?.value ?? "null")).toEqual({ month: now, level: 100 })
  })

  it("splits spend by project and leaves the home chat out of it", async () => {
    const stub = fresh()
    const created = await call(stub, "project-spend", "project.create", { slug: "billing", name: "Billing" })
    expect(created.result).toMatchObject({ slug: "billing" })
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("spend outside any project", "project-spend-chat")
      await home.harness.waitForIdle(context)
    })
    const summary = summaryOf((await call(stub, "project-spend-sum", "usage.summary", {})).result)
    expect(summary.tokens).toBeGreaterThan(0)
    expect(summary.byProject).toEqual([{ id: expect.any(String), name: "Billing", spend: 0, tokens: 0 }])
  }, 30_000)

  it("stores a credential sealed and lists its provider", async () => {
    const key = "sk-test-not-a-real-key"
    try {
      const set = await cmd("cred-1", "credential.set", { provider: "anthropic", key })
      expect(set).toMatchObject({ t: "ack", ok: true })
      expect(JSON.stringify(set)).not.toContain(key)
      const rows = await runInDurableObject(owner(), (home: Home) =>
        home.db.all<{ provider: string; sealed: string }>("SELECT provider, sealed FROM credentials"),
      )
      const row = rows.find((candidate) => candidate.provider === "anthropic")
      expect(row).toBeDefined()
      if (row === undefined) throw new Error("no stored credential")
      expect(row.sealed).not.toContain(key)
      expect(JSON.parse(row.sealed)).toMatchObject({ iv: expect.any(String), data: expect.any(String) })
      const listed = (await cmd("list-1", "models.list", {})) as {
        ok: boolean
        result: { models: { provider: string; modelId: string }[]; omittedModels: number }
      }
      expect(listed.ok).toBe(true)
      expect(listed.result.models.some((model) => model.provider === "anthropic")).toBe(true)
    } finally {
      await cmd("cred-2", "credential.delete", { provider: "anthropic" })
    }
  })

  it("adds the rest of the catalog only when asked, and prices every model", async () => {
    const keyedOnly = (await cmd("unkeyed-1", "models.list", {})) as ListReply
    expect(keyedOnly.ok).toBe(true)
    expect(keyedOnly.result.models.every((model) => model.keyed)).toBe(true)

    const complete = (await cmd("unkeyed-2", "models.list", { includeUnkeyed: true })) as ListReply
    expect(complete.ok).toBe(true)
    expect(complete.result.models.length).toBeGreaterThanOrEqual(keyedOnly.result.models.length)
    for (const model of keyedOnly.result.models) {
      expect(complete.result.models).toContainEqual(model)
    }
    const unkeyed = complete.result.models.filter((model) => !model.keyed)
    expect(unkeyed.length).toBeGreaterThan(0)
    const keyedIds = new Set(keyedOnly.result.models.map((model) => `${model.provider}/${model.modelId}`))
    expect(unkeyed.some((model) => !keyedIds.has(`${model.provider}/${model.modelId}`))).toBe(true)
    for (const model of complete.result.models) {
      expect(typeof model.keyed).toBe("boolean")
      expect(typeof model.cost.input).toBe("number")
      expect(typeof model.cost.output).toBe("number")
    }
  })

  it("serves the picker catalog with providers, prices, reasoning levels, favourites and enabled models", async () => {
    const stub = fresh()
    const EntrySchema = obj(
      {
        provider: str(),
        modelId: str(),
        contextWindow: num(),
        thinking: arr(str()),
        cost: obj({ input: num(), output: num(), cacheRead: num(), cacheWrite: num() }),
        keyed: bool(),
        enabled: bool(),
        favorite: bool(),
      },
      { open: true },
    )
    const CatalogSchema = obj(
      {
        providers: arr(obj({ id: str(), keyed: bool(), models: num(), enabled: num() }, { open: true })),
        models: arr(EntrySchema),
        favorites: arr(unknown()),
      },
      { open: true },
    )
    const catalogCheck = compile(CatalogSchema)
    type Catalog = Static<typeof CatalogSchema>
    type Entry = Catalog["models"][number]
    const catalog = async (id: string, args: object = {}): Promise<Catalog> => {
      const reply = await call(stub, id, "models.catalog", args)
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      if (!catalogCheck.check(reply.result)) throw new Error(`malformed catalog ${JSON.stringify(reply.result)}`)
      return reply.result
    }
    const entry = (found: Catalog, ref: { provider: string; modelId: string }): Entry | undefined =>
      found.models.find((model) => model.provider === ref.provider && model.modelId === ref.modelId)

    const first = await catalog("catalog-1", { provider: WIDE_MODEL.provider })
    const wide = entry(first, WIDE_MODEL)
    expect(wide).toMatchObject({
      contextWindow: 128_000,
      thinking: ["off"],
      keyed: true,
      enabled: true,
      favorite: false,
    })
    expect(typeof wide?.cost.cacheRead).toBe("number")
    expect(first.providers.find((provider) => provider.id === WIDE_MODEL.provider)).toMatchObject({
      keyed: true,
      models: 3,
      enabled: 3,
    })

    expect(await call(stub, "catalog-fav", "models.favorite", { model: WIDE_MODEL, favorite: true })).toMatchObject({
      ok: true,
      result: { favorites: [WIDE_MODEL] },
    })
    expect(await call(stub, "catalog-off", "models.enable", { model: WIDE_MODEL, enabled: false })).toMatchObject({
      ok: true,
    })
    const second = await catalog("catalog-2", { query: "alt" })
    expect(second.models[0]).toMatchObject({ ...WIDE_MODEL, favorite: true, enabled: false })
    expect(second.favorites).toEqual([WIDE_MODEL])
    const enabledOnly = await catalog("catalog-3", { provider: WIDE_MODEL.provider, enabledOnly: true })
    expect(entry(enabledOnly, WIDE_MODEL)).toBeUndefined()
    expect(enabledOnly.providers.find((provider) => provider.id === WIDE_MODEL.provider)).toMatchObject({ enabled: 2 })

    expect(await call(stub, "catalog-pick", "conv.configure", { model: WIDE_MODEL })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    await call(stub, "catalog-on", "models.enable", { model: WIDE_MODEL, enabled: true })
    expect(await call(stub, "catalog-pick-2", "conv.configure", { model: WIDE_MODEL })).toMatchObject({ ok: true })
  })

  it("keeps a disabled model out of models.list, owner defaults and delegate_task", async () => {
    const stub = fresh()
    const created = await call(stub, "off-project", "project.create", { slug: "off", name: "Off" })
    const project = created.result as { coordinatorId: number }
    expect(await call(stub, "off-default", "owner.defaults", { role: "chat", model: WIDE_MODEL })).toMatchObject({
      ok: true,
    })
    expect(await call(stub, "off-refused", "models.enable", { model: WIDE_MODEL, enabled: false })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
    expect(await call(stub, "off-narrow", "models.enable", { model: narrow, enabled: false })).toMatchObject({
      ok: true,
    })

    const listed = (await call(stub, "off-list", "models.list", { includeUnkeyed: true })) as ListReply
    expect(listed.result.models.some((model) => model.modelId === narrow.modelId)).toBe(false)
    expect(listed.result.models.find((model) => model.modelId === WIDE_MODEL.modelId)).toMatchObject({
      thinking: ["off"],
    })
    expect(await call(stub, "off-thread-default", "owner.defaults", { role: "thread", model: narrow })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })

    const outcome = await runInDurableObject(stub, (home: Home) =>
      home.loader.ctx.threads.delegate(
        { conversationId: project.coordinatorId as ConversationId, taskId: "off-task" },
        { task: "say hi", title: "hi", choice: { model: narrow }, mode: "async", clientRequestId: "off-delegate" },
        context,
      ),
    )
    expect(outcome).toMatchObject({ kind: "no_model" })
  })

  it("moves conversations off a model the owner disables and keeps it out of Captains and project defaults", async () => {
    const stub = fresh()
    const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
    const created = await call(stub, "move-project", "project.create", { slug: "move", name: "Move" })
    const project = created.result as { id: string; coordinatorId: number }
    const [thread] = await addThreads(stub, project.id, ["mover"])
    if (thread === undefined) throw new Error("no thread")
    await call(stub, "move-default", "owner.defaults", { role: "chat", model: WIDE_MODEL })
    await call(stub, "move-coord", "conv.configure", { conv: project.coordinatorId, model: narrow })
    await call(stub, "move-thread", "conv.configure", { conv: thread.id, model: narrow })

    await call(stub, "move-project-default", "project.update", {
      id: project.id,
      settings: { models: { thread: narrow } },
    })
    expect(await call(stub, "move-refused", "models.enable", { model: narrow, enabled: false })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    await call(stub, "move-project-clear", "project.update", {
      id: project.id,
      settings: { models: { thread: WIDE_MODEL } },
    })

    const disabled = await call(stub, "move-off", "models.enable", { model: narrow, enabled: false })
    expect(disabled).toMatchObject({ ok: true })
    expect((disabled.result as { moved: number[] }).moved.toSorted()).toEqual(
      [project.coordinatorId, thread.id].toSorted(),
    )
    const models = await runInDurableObject(stub, async (home: Home) =>
      Promise.all(
        [project.coordinatorId, thread.id].map(async (id) => {
          const conversation = await home.harness.conversation(id as ConversationId, context)
          return conversation === undefined ? undefined : (await conversation.agent(context)).model
        }),
      ),
    )
    expect(models).toEqual([WIDE_MODEL, WIDE_MODEL])

    expect(
      await call(stub, "move-project-off", "project.update", {
        id: project.id,
        settings: { models: { chat: narrow } },
      }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(
      await call(stub, "move-captain", "captain.create", { projectId: project.id, name: "Off Captain", model: narrow }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  }, 30_000)

  it("moves Puck chats, pruned threads and automation threads off a disabled model too", async () => {
    const stub = fresh()
    const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
    const created = await call(stub, "every-project", "project.create", { slug: "every", name: "Every" })
    const project = created.result as { id: string; coordinatorId: number }
    const [pruned] = await addThreads(stub, project.id, ["pruned"])
    if (pruned === undefined) throw new Error("no thread")
    await call(stub, "every-default", "owner.defaults", { role: "chat", model: WIDE_MODEL })
    await call(stub, "every-thread-default", "owner.defaults", { role: "thread", model: WIDE_MODEL })
    await call(stub, "every-coord", "conv.configure", { conv: project.coordinatorId, model: WIDE_MODEL })
    const puck = (await call(stub, "every-puck", "puck.create", { title: "side" })).result as { id: string }
    const automation = (await call(stub, "every-auto", "automation.create", {
      title: "Standing",
      prompt: "Keep notes",
      project: project.id,
      target: { kind: "same" },
      triggers: [],
    })) as { result: { id: string } }
    const run = (await call(stub, "every-auto-run", "automation.trigger", { id: automation.result.id })) as {
      result: { threadId: number }
    }
    const standing = run.result.threadId
    expect(standing, JSON.stringify(run)).toEqual(expect.any(Number))
    await runInDurableObject(stub, (home: Home) =>
      home.harness.commit(async (tx) => {
        for (const space of Object.values((await tx.doc(WorkspaceDoc)).spaces))
          space.threadIds = space.threadIds.filter((id) => id !== pruned.id)
      }, context),
    )
    const targets = [Number(puck.id), pruned.id, standing]
    for (const [index, conv] of targets.entries()) {
      const configured = await call(stub, `every-narrow-${index}`, "conv.configure", { conv, model: narrow })
      expect(configured.ok, JSON.stringify({ conv, configured })).toBe(true)
    }

    const disabled = await call(stub, "every-off", "models.enable", { model: narrow, enabled: false })
    expect((disabled.result as { moved: number[] }).moved.toSorted()).toEqual(targets.toSorted())
    const after = await runInDurableObject(stub, async (home: Home) =>
      Promise.all(
        targets.map(async (id) => (await home.harness.conversation(id as ConversationId, context))?.agent(context)),
      ),
    )
    expect(after.map((agent) => agent?.model)).toEqual([WIDE_MODEL, WIDE_MODEL, WIDE_MODEL])
  }, 30_000)

  it("refuses to start a turn or a thread on a disabled model at every start point", async () => {
    const stub = fresh()
    const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
    const created = await call(stub, "start-project", "project.create", { slug: "start", name: "Start" })
    const project = created.result as { id: string; coordinatorId: number }
    const [thread] = await addThreads(stub, project.id, ["starter"])
    if (thread === undefined) throw new Error("no thread")
    const captain = (await call(stub, "start-captain", "captain.create", {
      projectId: project.id,
      name: "Start Captain",
      model: WIDE_MODEL,
    })) as { ok: boolean; result: { id: string } }
    expect(captain.ok, JSON.stringify(captain)).toBe(true)
    await call(stub, "start-off", "models.enable", { model: narrow, enabled: false })
    await runInDurableObject(stub, async (home: Home) => {
      await home.root()
      for (const id of [ROOT_CONVERSATION_ID, project.coordinatorId, thread.id])
        await (await home.harness.conversation(id as ConversationId, context))?.configure({ model: narrow }, context)
    })

    const refused = { ok: false, error: { code: "bad_args" } }
    expect(await call(stub, "start-msg", "message.send", { text: "hi", clientTs: 1 })).toMatchObject(refused)
    expect(
      await call(stub, "start-send", "thread.send", { threadId: thread.id, text: "again", mode: "queue" }),
    ).toMatchObject(refused)
    expect(
      await call(stub, "start-create", "thread.create", { title: "t", task: "do it", project: project.id }),
    ).toMatchObject(refused)
    expect(
      await call(stub, "start-side", "thread.side", { conv: project.coordinatorId, title: "t", task: "do it" }),
    ).toMatchObject(refused)
    expect(
      await call(stub, "start-captain-update", "captain.update", { id: captain.result.id, model: narrow }),
    ).toMatchObject(refused)
    const outcome = await runInDurableObject(stub, (home: Home) =>
      home.loader.ctx.threads.delegate(
        { conversationId: project.coordinatorId as ConversationId, taskId: "start-task" },
        { task: "say hi", title: "hi", mode: "async", clientRequestId: "start-delegate" },
        context,
      ),
    )
    expect(outcome).toMatchObject({ kind: "no_model" })
  }, 30_000)

  it("checks a disabled model at send time without reading a row", async () => {
    const stub = fresh()
    const counts = await runInDurableObject(stub, async (home: Home) => {
      await home.root()
      const calls = (match: (sql: string) => boolean): number =>
        Object.entries(home.meter().statements)
          .filter(([sql]) => match(sql))
          .reduce((sum, [, bucket]) => sum + bucket.calls, 0)
      const any = () => calls(() => true)
      const kv = () => calls((sql) => sql.includes("FROM kv"))
      const before = any()
      await home.services.models.disabled(FAUX_MODEL)
      const check = any() - before
      const spendBefore = kv()
      await home.services.models.spend()
      const spend = kv() - spendBefore
      const sendBefore = kv()
      await home.commands.run(
        { id: crypto.randomUUID() as CommandId, op: "message.send", args: { text: "hi", clientTs: 1 } },
        { kind: "owner" },
      )
      return { check, spend, send: kv() - sendBefore }
    })
    expect(counts.check).toBe(0)
    expect(counts.send).toBe(counts.spend)
  })

  it("rejects a configure onto a model disabled after the disable's move-off scan already ran", async () => {
    const stub = fresh()
    const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const root = await home.root()
      const run = (op: string, args: object) =>
        home.commands.run({ id: crypto.randomUUID() as CommandId, op, args }, { kind: "owner" })
      const disabled = await run("models.enable", { model: narrow, enabled: false })
      const configured = await run("conv.configure", { model: narrow })
      return { configured, disabled, model: (await root.agent(context)).model }
    })
    expect(outcome.disabled).toMatchObject({ kind: "ok" })
    expect(outcome.configured).toMatchObject({ kind: "rejected", code: "bad_args" })
    expect(outcome.model).not.toEqual(narrow)
  })

  it("compacts at the owner's share of each model's window and reports that point in conv.context", async () => {
    const stub = fresh()
    await call(stub, "compact-at-model", "conv.configure", { model: WIDE_MODEL })
    const compactAt = async (id: string): Promise<unknown> => {
      const reply = await call(stub, id, "conv.context", {})
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      return field(reply.result, "compactAt")
    }
    expect(await compactAt("compact-at-default")).toBe(
      128_000 - DEFAULT_COMPACTION_POLICY.reserveTokens - DEFAULT_COMPACTION_POLICY.backgroundTokens,
    )
    expect(await call(stub, "compact-at-set", "owner.compaction.set", { percent: 80 })).toMatchObject({
      ok: true,
      result: { percent: 80 },
    })
    expect(await compactAt("compact-at-80")).toBe(102_400)
    const reserve = await runInDurableObject(
      stub,
      (home: Home) =>
        home.loader.ctx.pi.compactionSources[0]?.()?.modelOverrides?.[`${WIDE_MODEL.provider}/${WIDE_MODEL.modelId}`],
    )
    expect(reserve).toEqual({ reserveTokens: 12_288, backgroundTokens: 13_312, keepRecentTokens: 20_000 })
    expect(await call(stub, "compact-at-low", "owner.compaction.set", { percent: 30 })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    await call(stub, "compact-at-clear", "owner.compaction.set", { percent: null })
    expect(await compactAt("compact-at-cleared")).toBe(
      128_000 - DEFAULT_COMPACTION_POLICY.reserveTokens - DEFAULT_COMPACTION_POLICY.backgroundTokens,
    )
    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.pi.compactionSources[0]?.())).toBeUndefined()
  })

  for (const percent of [90, 95])
    it(`keeps room for the reply on a 32k model at ${percent}%`, async () => {
      const stub = fresh()
      const narrow = { provider: WIDE_MODEL.provider, modelId: "alt-narrow" }
      await call(stub, `narrow-model-${percent}`, "conv.configure", { model: narrow })
      expect((await call(stub, `narrow-set-${percent}`, "owner.compaction.set", { percent })).ok).toBe(true)
      const reply = await call(stub, `narrow-context-${percent}`, "conv.context", {})
      const room = 8_192 + 4_096
      expect(field(reply.result, "compactAt")).toBe(32_768 - room)
      const policy = await runInDurableObject(
        stub,
        (home: Home) =>
          home.loader.ctx.pi.compactionSources[0]?.()?.modelOverrides?.[`${narrow.provider}/${narrow.modelId}`],
      )
      expect(policy).toEqual({
        reserveTokens: room,
        backgroundTokens: 0,
        keepRecentTokens: Math.floor((32_768 - room) / 4),
      })
    })

  for (const percent of [50, 80])
    it(`compacts once near ${percent}% of a 128k window and not again on the next turn`, async () => {
      resetAlt()
      const stub = fresh()
      expect((await call(stub, `fire-set-${percent}`, "owner.compaction.set", { percent })).ok).toBe(true)
      const threshold = (128_000 * percent) / 100
      const chunk = "word ".repeat(Math.round((threshold * 0.28 * 4) / 5))
      const compactions = (): Promise<number> => runInDurableObject(stub, compactionsIn)
      for (let index = 0; index < 3; index++)
        await turn(stub, `fire-${percent}-${index}`, { text: chunk, model: WIDE_MODEL })
      expect(await compactions()).toBe(0)
      await turn(stub, `fire-${percent}-over`, { text: chunk, model: WIDE_MODEL })
      await eventually(stub, async (home: Home) => (await compactionsIn(home)) >= 1)
      await turn(stub, `fire-${percent}-next`, { text: "ok", model: WIDE_MODEL })
      await runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))
      expect(await compactions()).toBe(1)
    }, 60_000)

  it("declares owner.compaction a read, so it announces no change, while owner.compaction.set does", async () => {
    expect((await postCommand("owner.compaction", {})).headers.get("x-ingle-rev")).toBeNull()
    const set = await postCommand("owner.compaction.set", { percent: 70 })
    expect(set.headers.get("x-ingle-rev")).not.toBeNull()
    await postCommand("owner.compaction.set", { percent: null })
  })

  it("rebuilds the compaction overrides when the catalog changes but keeps its size", async () => {
    const original = globalThis.fetch
    let listed = { id: "swap-1", context_window: 64_000 }
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ object: "list", data: [{ ...listed, object: "model" }] }), {
        headers: { "content-type": "application/json" },
      })
    const stub = fresh()
    const keys = (): Promise<string[]> =>
      runInDurableObject(stub, (home: Home) =>
        Object.keys(home.loader.ctx.pi.compactionSources[0]?.()?.modelOverrides ?? {}).filter((key) =>
          key.startsWith("swap/"),
        ),
      )
    try {
      const set = await call(stub, "swap-cred", "credential.set", {
        provider: "swap",
        key: "swap-key",
        custom: { baseUrl: "https://swap.test/v1", key: "swap-key", api: "openai-completions" },
      })
      expect(set.ok, JSON.stringify(set)).toBe(true)
      expect((await call(stub, "swap-percent", "owner.compaction.set", { percent: 80 })).ok).toBe(true)
      expect((await call(stub, "swap-list-1", "models.catalog", { provider: "swap" })).ok).toBe(true)
      expect(await keys()).toEqual(["swap/swap-1"])
      listed = { id: "swap-2", context_window: 32_000 }
      expect((await call(stub, "swap-list-2", "models.catalog", { provider: "swap" })).ok).toBe(true)
      expect(await keys()).toEqual(["swap/swap-2"])
    } finally {
      globalThis.fetch = original
    }
  })

  it("keeps a stored custom endpoint resolvable without listing its models first", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "stub-1", object: "model" }] }), {
        headers: { "content-type": "application/json" },
      })
    try {
      const set = await cmd("custom-1", "credential.set", {
        provider: "endpoint",
        key: "endpoint-key",
        custom: { baseUrl: "https://endpoint.test/v1", key: "endpoint-key", api: "openai-completions" },
      })
      expect(set).toMatchObject({ ok: true })
      const accepted = await cmd("custom-2", "owner.defaults", {
        role: "chat",
        model: { provider: "endpoint", modelId: "stub-1" },
      })
      expect(accepted).toMatchObject({ ok: true })
    } finally {
      globalThis.fetch = original
      await cmd("custom-3", "credential.delete", { provider: "endpoint" })
    }
  })

  it("keeps a custom provider's endpoint when its key alone is edited", async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization") ?? ""}`)
      return new Response(JSON.stringify({ object: "list", data: [{ id: "stub-1", object: "model" }] }), {
        headers: { "content-type": "application/json" },
      })
    }
    try {
      const created = await cmd("edit-custom-1", "credential.set", {
        provider: "edited",
        custom: { baseUrl: "https://edited.test/v1", key: "first-key", api: "openai-completions" },
      })
      expect(created).toMatchObject({ ok: true })
      const edited = await cmd("edit-custom-2", "credential.set", { provider: "edited", key: "second-key" })
      expect(edited).toMatchObject({ ok: true, result: { provider: "edited", custom: false } })

      seen.length = 0
      const listed = (await cmd("edit-custom-3", "models.catalog", {})) as {
        result: { providers: { id: string; custom: boolean; keyed: boolean }[] }
      }
      const providers = listed.result.providers
      expect(providers.find((provider) => provider.id === "edited")).toMatchObject({ custom: true, keyed: true })
      const accepted = await cmd("edit-custom-4", "owner.defaults", {
        role: "chat",
        model: { provider: "edited", modelId: "stub-1" },
      })
      expect(accepted).toMatchObject({ ok: true })
      expect(seen.some((line) => line.startsWith("https://edited.test/v1/") && line.endsWith("second-key"))).toBe(true)
    } finally {
      globalThis.fetch = original
      await cmd("edit-custom-5", "credential.delete", { provider: "edited" })
    }
  })

  it("refreshes only the custom provider whose credential changed, once and with its new key", async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${new URL(String(input)).host} ${new Headers(init?.headers).get("authorization") ?? ""}`)
      return new Response(JSON.stringify({ object: "list", data: [{ id: "stub-1", object: "model" }] }), {
        headers: { "content-type": "application/json" },
      })
    }
    const stub = fresh()
    const requests = async (id: string, op: string, args: unknown): Promise<string[]> => {
      seen.length = 0
      const reply = await call(stub, id, op, args)
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      return [...seen]
    }
    try {
      expect(
        await requests("rotate-1", "credential.set", { provider: "kept", custom: custom("kept.test", "kept-key") }),
      ).toEqual(["kept.test Bearer kept-key"])
      expect(
        await requests("rotate-2", "credential.set", {
          provider: "rotate",
          custom: custom("rotate.test", "first-key"),
        }),
      ).toEqual(["rotate.test Bearer first-key"])
      expect(
        await requests("rotate-3", "credential.set", {
          provider: "rotate",
          custom: custom("rotate.test", "second-key"),
        }),
      ).toEqual(["rotate.test Bearer second-key"])
      expect(await requests("rotate-4", "credential.set", { provider: "rotate", key: "third-key" })).toEqual([
        "rotate.test Bearer third-key",
      ])
      expect(await requests("rotate-5", "credential.delete", { provider: "rotate" })).toEqual([])
      expect(await requests("rotate-6", "models.catalog", {})).toEqual(["kept.test Bearer kept-key"])
    } finally {
      globalThis.fetch = original
    }
  })

  it("confines an agent's model changes to itself or its own project's threads", async () => {
    const stub = fresh()
    const created = await call(stub, "scope-project", "project.create", { slug: "scope", name: "Scope" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = created.result as { id: string; coordinatorId: number }
    const [alpha, beta] = await addThreads(stub, project.id, ["alpha", "beta"])
    if (alpha === undefined || beta === undefined) throw new Error("no threads")
    const coordinator: Actor = { kind: "agent", conversationId: project.coordinatorId as ConversationId }
    const child: Actor = { kind: "agent", conversationId: alpha.id }
    const run = (id: string, conv: number, actor: Actor) =>
      runInDurableObject(stub, (home: Home) =>
        home.commands.run({ id: id as CommandId, op: "conv.configure", args: { conv, model: WIDE_MODEL } }, actor),
      )

    expect(await run("scope-self", alpha.id, child)).toMatchObject({ kind: "ok" })
    expect(await run("scope-sibling", beta.id, child)).toMatchObject({ kind: "rejected", code: "forbidden" })
    expect(await run("scope-parent", project.coordinatorId, child)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run("scope-coordinator", beta.id, coordinator)).toMatchObject({ kind: "ok" })

    const other = await call(stub, "scope-other", "project.create", { slug: "other", name: "Other" })
    const stranger: Actor = {
      kind: "agent",
      conversationId: (other.result as { coordinatorId: number }).coordinatorId as ConversationId,
    }
    expect(await run("scope-stranger", beta.id, stranger)).toMatchObject({ kind: "rejected", code: "forbidden" })
  })

  it("reports context usage by category, estimated before a reply and measured after", async () => {
    const stub = fresh()
    await runInDurableObject(stub, (home: Home) => home.chooseModel(FAUX_MODEL))
    const before = await readContext(stub, "ctx-1")
    expect(before.measured).toBe(false)
    expect(before.model).toEqual(FAUX_MODEL)
    expect(before.categories.map((entry) => entry.key)).toEqual(["system", "tools", "conversation"])
    const [system, tools] = before.categories
    expect(system?.tokens).toBeGreaterThan(0)
    expect(tools?.tokens).toBeGreaterThan(0)
    expect(before.compactAt).toBe(
      before.contextWindow - DEFAULT_COMPACTION_POLICY.reserveTokens - DEFAULT_COMPACTION_POLICY.backgroundTokens,
    )

    const entries = await runInDurableObject(stub, async (home: Home) => {
      await home.submit("hello", "ctx-turn")
      await home.harness.waitForIdle(context)
      return history(await home.root())
    })
    const usage = entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === "assistant")?.usage
    if (usage === undefined) throw new Error("no assistant usage")
    const after = await readContext(stub, "ctx-2")
    expect(after.measured).toBe(true)
    expect(after.used).toBe(usage.input + usage.cacheRead + usage.cacheWrite + usage.output)

    await runInDurableObject(stub, async (home: Home) => {
      await home.submit("context ".repeat(24_000), "ctx-turn-2")
      await home.harness.waitForIdle(context)
      await home.submit("one more", "ctx-turn-3")
      await home.harness.waitForIdle(context)
      const task = await (await home.root()).compact(undefined, context)
      await home.harness.waitForTask(task, context)
    })
    const compacted = await readContext(stub, "ctx-3")
    expect(compacted.measured).toBe(false)
  })

  it("rejects an unknown model and keeps owner defaults", async () => {
    const rejected = await cmd("conf-1", "conv.configure", { model: { provider: "faux-alt", modelId: "nope" } })
    expect(rejected).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(await cmd("def-1", "owner.defaults", { role: "chat", model: WIDE_MODEL })).toMatchObject({
      ok: true,
      result: { role: "chat", model: WIDE_MODEL },
    })
    const rows = await runInDurableObject(owner(), (home: Home) =>
      home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", "owner.defaults"),
    )
    expect(rows?.value).toBe(JSON.stringify({ chat: WIDE_MODEL }))
  })

  it("resolves conversation, then project, then owner, and never falls back", () => {
    const conversation = { provider: "p", modelId: "a" }
    const project = { chat: { provider: "p", modelId: "b" } }
    const ownerDefaults = { chat: { provider: "p", modelId: "c" } }
    expect(resolveModel({ role: "chat", conversation, project, owner: ownerDefaults })).toEqual({
      kind: "model",
      model: conversation,
      source: "conversation",
    })
    expect(resolveModel({ role: "chat", project, owner: ownerDefaults })).toEqual({
      kind: "model",
      model: project.chat,
      source: "project",
    })
    expect(resolveModel({ role: "chat", owner: ownerDefaults })).toEqual({
      kind: "model",
      model: ownerDefaults.chat,
      source: "owner",
    })
    expect(resolveModel({ role: "chat" })).toEqual({ kind: "none" })
  })

  it("names no model ids in the models module", () => {
    expect(source).not.toMatch(/faux-|alt-wide|alt-narrow|gpt-|claude-|gemini-|opus|sonnet|llama|deepseek/i)
  })
})
