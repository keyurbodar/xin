import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai"
import type { Conversation, EntryRecord, TaskId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
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

describe("compact", () => {
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
    expect(manifest.xin.plugins.compact).toEqual({
      module: "./index.ts",
      title: "Compaction",
      description: "Manual conversation compaction for the owner.",
    })
    expect(manifest.xin.bundle).toEqual([{ id: "compact", plugin: "compact" }])
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
