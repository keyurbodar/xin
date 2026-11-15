import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai"
import {
  type Conversation,
  defineExtension,
  defineTool,
  type EntryRecord,
  type TaskId,
  UsageDoc,
} from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { DREAM_MODEL, requests as utilityRequests, script as scriptUtility } from "../../test/plugins/m7.ts"
import { answer, M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, eventually, field, fresh, rowOf, turn, type Stub } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import * as compact from "./index.ts"
import manifest from "./package.json"

const context = BACKGROUND_CONTEXT
const BIG = "context ".repeat(24_000)

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const promptText = (messages: TranscriptContext["messages"]): string =>
  messages.map((message) => textOf(message.content)).join("\n\n")

const history = async (conversation: Conversation): Promise<readonly EntryRecord[]> =>
  (await conversation.entries({ order: "ascending" }, 500, undefined, context)).items

const mount = (stub: Stub): Promise<void> =>
  runInDurableObject(stub, async (home: Home) => {
    if (home.loader.rows().some((row) => row.id === "compact")) return
    home.loader.builtins.compact = compact
    await home.loader.create({ id: "compact", name: "cordis:compact" })
    await home.loader.await()
  })

const HEAD = "HEAD-OF-THE-LOG "
const MIDDLE = "middle-of-the-log "
const TAIL = " TAIL-OF-THE-LOG"
const LOG = `${HEAD}${MIDDLE.repeat(2_400)}${TAIL}`
const DUMPS = 5
const SUMMARY_ASK = "Create a structured context checkpoint summary"

const dump = defineTool({
  name: "dump_log",
  description: "Return the whole build log.",
  parameters: obj({}),
  execute: async () => ({ output: [{ type: "text", text: LOG }] }),
})

const withDump = (stub: Stub): Promise<void> =>
  runInDurableObject(stub, async (home: Home) => {
    if (!home.loader.ctx.pi.installed.has("tool-compact-dump"))
      home.loader.ctx.pi.install(defineExtension({ name: "tool-compact-dump", tools: [dump] }))
  })

const useUtility = (stub: Stub, utility: { provider: string; modelId: string } = DREAM_MODEL): Promise<void> =>
  runInDurableObject(stub, (home: Home) =>
    home.db.run(
      "INSERT INTO kv (key, value) VALUES ('owner.defaults', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ utility }),
    ),
  )

const CHAT_COMPACTION = `compaction:${M8_MODEL.provider}/${M8_MODEL.modelId}`

const chargedTokens = (stub: Stub): Promise<Record<string, number>> =>
  runInDurableObject(stub, async (home: Home) => {
    const usage = await home.harness.snapshot(UsageDoc, (await home.root()).id, context)
    return Object.fromEntries(
      Object.entries(usage?.models ?? {}).flatMap(([key, total]) =>
        key.startsWith("compaction:") ? [[key, total.totalTokens]] : [],
      ),
    )
  })

const summaryRequests = (seen: readonly TranscriptContext[]): number =>
  seen.filter((request) => promptText(request.messages).includes(SUMMARY_ASK)).length

const chat = (seen: TranscriptContext[]): FauxResponseStep[] =>
  Array.from({ length: 8 }, (_, index) => (request: TranscriptContext) => {
    seen.push(request)
    if (promptText(request.messages).includes(SUMMARY_ASK)) return fauxAssistantMessage("default summary")
    if (index < DUMPS)
      return fauxAssistantMessage([fauxToolCall("dump_log", {}, { id: `dump-${index}` })], { stopReason: "toolUse" })
    return fauxAssistantMessage(`answer ${index}`)
  })

async function thresholdCompaction(stub: Stub, firstText: string): Promise<string> {
  await mount(stub)
  await withDump(stub)
  await turn(stub, `compact-log-${crypto.randomUUID()}`, { text: firstText })
  await turn(stub, `compact-next-${crypto.randomUUID()}`, { text: "next ".repeat(24_000) })
  await eventually(stub, async (home: Home) =>
    (await history(await home.root())).some((candidate) => candidate.kind === "pi.compaction"),
  )
  const entries = await runInDurableObject(stub, async (home: Home) => history(await home.root()))
  const entry = entries.find((candidate) => candidate.kind === "pi.compaction")
  expect(entry?.data).toMatchObject({ reason: "threshold" })
  return promptText([...(entry?.model ?? [])])
}

describe("compact", () => {
  it("places a pruned transcript for a threshold compaction a huge tool result dominates, with no model call", async () => {
    const stub = fresh()
    const seen: TranscriptContext[] = []
    respond(chat(seen))
    scriptUtility([])
    await useUtility(stub)

    const summary = await thresholdCompaction(stub, "read the build log")

    expect(summaryRequests(seen)).toBe(0)
    expect(utilityRequests).toHaveLength(0)
    expect(summary).toContain("[User]: read the build log")
    expect(summary).toContain(HEAD)
    expect(summary).toContain(TAIL)
    expect(summary).toContain("chars pruned")
    expect(summary.split(MIDDLE.trim()).length - 1).toBeLessThan(120 * DUMPS)
    expect(summary.length).toBeLessThan(20_000)
  }, 60_000)

  it("summarizes on the owner's utility model when pruning leaves too much", async () => {
    const stub = fresh()
    const seen: TranscriptContext[] = []
    respond(chat(seen))
    scriptUtility([fauxAssistantMessage("utility summary")])
    await useUtility(stub)

    const summary = await thresholdCompaction(stub, `read the build log ${"notes ".repeat(8_000)}`)

    expect(summaryRequests(seen)).toBe(0)
    expect(utilityRequests).toHaveLength(1)
    expect(promptText(utilityRequests[0]!.messages)).toContain(SUMMARY_ASK)
    expect(promptText(utilityRequests[0]!.messages)).toContain(TAIL)
    expect(summary).toContain("utility summary")
    const usage = await runInDurableObject(stub, async (home: Home) =>
      home.harness.snapshot(UsageDoc, (await home.root()).id, context),
    )
    expect(usage?.models[`compaction:${DREAM_MODEL.provider}/${DREAM_MODEL.modelId}`]?.totalTokens).toBeGreaterThan(0)
  }, 60_000)

  it("summarizes on the conversation's model, charged as compaction, without a utility default", async () => {
    const stub = fresh()
    const seen: TranscriptContext[] = []
    respond(chat(seen))
    scriptUtility([])

    const summary = await thresholdCompaction(stub, `read the build log ${"notes ".repeat(8_000)}`)

    expect(summaryRequests(seen)).toBe(1)
    expect(utilityRequests).toHaveLength(0)
    expect(summary).toContain("default summary")
    expect(Object.keys(await chargedTokens(stub))).toEqual([CHAT_COMPACTION])
    expect((await chargedTokens(stub))[CHAT_COMPACTION]).toBeGreaterThan(0)
  }, 60_000)

  it("summarizes once, charged as compaction, when the utility model is the conversation's model", async () => {
    const stub = fresh()
    const seen: TranscriptContext[] = []
    respond(chat(seen))
    scriptUtility([])
    await useUtility(stub, M8_MODEL)

    const summary = await thresholdCompaction(stub, `read the build log ${"notes ".repeat(8_000)}`)

    expect(summaryRequests(seen)).toBe(1)
    expect(utilityRequests).toHaveLength(0)
    expect(summary).toContain("default summary")
    expect(Object.keys(await chargedTokens(stub))).toEqual([CHAT_COMPACTION])
  }, 60_000)

  it("falls back to the conversation's model, charged as compaction, when the utility call fails", async () => {
    const stub = fresh()
    const seen: TranscriptContext[] = []
    respond(chat(seen))
    scriptUtility([fauxAssistantMessage("", { stopReason: "error", errorMessage: "utility down" })])
    await useUtility(stub)

    const summary = await thresholdCompaction(stub, `read the build log ${"notes ".repeat(8_000)}`)

    expect(utilityRequests).toHaveLength(1)
    expect(summaryRequests(seen)).toBe(1)
    expect(summary).toContain("default summary")
    expect((await chargedTokens(stub))[CHAT_COMPACTION]).toBeGreaterThan(0)
  }, 60_000)

  it("condenses an idle conversation and answers with the compaction id", async () => {
    const stub = fresh()
    await mount(stub)
    respond([answer("warm up answer")])
    await turn(stub, `compact-turn-1-${crypto.randomUUID()}`, { text: "warm up" })
    respond([answer("first answer")])
    await turn(stub, `compact-turn-2-${crypto.randomUUID()}`, { text: BIG, model: M8_MODEL })
    respond([answer("second answer")])
    await turn(stub, `compact-turn-3-${crypto.randomUUID()}`, { text: "one more exchange" })

    const prompts: string[] = []
    const capture: FauxResponseStep = (request) => {
      prompts.push(promptText(request.messages))
      return fauxAssistantMessage("the early history was condensed")
    }
    respond([capture])

    const rootId = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
    const ack = await cmd(stub, `compact-idle-${crypto.randomUUID()}`, "conv.compact", {
      conversationId: rootId,
      instructions: "keep the failing test names",
    })
    expect(ack).toMatchObject({ ok: true })
    const compaction = field(ack.result, "compaction")
    if (typeof compaction !== "number") throw new Error(`no compaction id in ${JSON.stringify(ack)}`)

    await runInDurableObject(stub, async (home: Home) => {
      const settled = await home.harness.waitForTask(compaction as TaskId, context)
      expect(settled.state.status).toBe("terminal")
    })
    await eventually(stub, async (home: Home) =>
      (await history(await home.root())).some((candidate) => candidate.kind === "pi.compaction"),
    )
    const entries = await runInDurableObject(stub, async (home: Home) => history(await home.root()))
    const entry = entries.find((candidate) => candidate.kind === "pi.compaction")
    expect(entry?.data).toMatchObject({ reason: "manual" })
    expect(prompts.join("\n")).toContain("Additional focus: keep the failing test names")
  }, 30_000)

  it("answers busy while the conversation has a live run", async () => {
    const stub = fresh()
    await mount(stub)
    const rootId = await runInDurableObject(stub, async (home: Home) => {
      home.script(["hang"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("a long job", `compact-busy-${crypto.randomUUID()}`)
      return (await home.root()).id
    })
    await runInDurableObject(stub, (home: Home) => home.hanging.promise)

    const ack = await cmd(stub, `compact-busy-${crypto.randomUUID()}`, "conv.compact", { conversationId: rootId })
    expect(ack).toMatchObject({ ok: false, error: { code: "busy" } })

    await runInDurableObject(stub, async (home: Home) => {
      await (await home.root()).abort(context)
    })
  }, 15_000)

  it("answers bad_args for an unknown conversation and for unusable instructions", async () => {
    const stub = fresh()
    await mount(stub)
    const rootId = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
    const unknown = await cmd(stub, `compact-unknown-${crypto.randomUUID()}`, "conv.compact", {
      conversationId: 999_999,
    })
    expect(unknown).toMatchObject({ ok: false, error: { code: "bad_args" } })
    const tooLong = await cmd(stub, `compact-long-${crypto.randomUUID()}`, "conv.compact", {
      conversationId: rootId,
      instructions: "x".repeat(2001),
    })
    expect(tooLong).toMatchObject({ ok: false, error: { code: "bad_args" } })
    const empty = await cmd(stub, `compact-empty-${crypto.randomUUID()}`, "conv.compact", {
      conversationId: rootId,
      instructions: "",
    })
    expect(empty).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })

  it("declares one bundle row for the composed tree", () => {
    expect(manifest.ingle.plugins.compact).toEqual({
      module: "./index.ts",
      title: "Compaction",
      description:
        "Conversation compaction: the owner's manual compaction, tool-result pruning and summaries on the utility model.",
    })
    expect(manifest.ingle.bundle).toEqual([{ id: "compact", plugin: "compact" }])
  })

  it("loads its row beside the composed tree and registers conv.compact", async () => {
    const stub = fresh()
    await mount(stub)
    expect(await rowOf(stub, "compact")).toMatchObject({ state: { kind: "active" } })
    const rootId = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
    const ack = await cmd(stub, `compact-mounted-${crypto.randomUUID()}`, "conv.compact", { conversationId: rootId })
    expect(ack).toMatchObject({ ok: true, result: { compaction: expect.any(Number) } })
  })
})
