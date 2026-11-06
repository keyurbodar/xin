import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
// @ts-expect-error Vite inlines ?raw imports at bundle time
import source from "./models.ts?raw"
import { resolveModel } from "../../src/contracts/models.ts"
import { api, fresh, owner } from "../../test/support.ts"
import { WIDE_MODEL } from "../../test/plugins/m3.ts"
import type { Home } from "../../test/worker.ts"

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
