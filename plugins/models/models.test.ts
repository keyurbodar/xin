import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
// @ts-expect-error Vite inlines ?raw imports at bundle time
import source from "./models.ts?raw"
import { resolveModel } from "../../src/contracts/models.ts"
import { api, cmd as call, fresh, owner } from "../../test/support.ts"
import { WIDE_MODEL } from "../../test/plugins/m3.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

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

type Slice = {
  readonly name?: string
  readonly provider?: string
  readonly modelId?: string
  readonly totalTokens: number
  readonly cost: number
}
type Dated = { readonly spend: number; readonly tokens: number }
type Summary = {
  readonly spend: number
  readonly tokens: number
  readonly today: Dated
  readonly month: Dated
  readonly byModel: readonly Slice[]
  readonly byTool: readonly Slice[]
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
  if (typeof spend !== "number" || typeof tokens !== "number") throw new Error("bad usage summary")
  return {
    spend,
    tokens,
    today: datedOf(Reflect.get(value, "today")),
    month: datedOf(Reflect.get(value, "month")),
    byModel: Array.isArray(byModel) ? byModel.map(sliceOf) : [],
    byTool: Array.isArray(byTool) ? byTool.map(sliceOf) : [],
  }
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
