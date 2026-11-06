import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, ConversationId, EntryRecord } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { eventually, fresh } from "../test/support.ts"
import { FAUX_MODEL, type Home } from "../test/worker.ts"

const context = BACKGROUND_CONTEXT

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
  return [...page.items]
}

const texts = (entries: readonly EntryRecord[], role: "user" | "assistant") =>
  entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === role && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : message.role === role && typeof message.content === "string"
          ? [message.content]
          : [],
    ),
  )

describe("Home host loop", () => {
  it("runs migrations once and keeps the fallback alarm only while work can run", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      const rows = await home.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
      )
      expect(rows).toEqual([{ name: "kv" }])
    })
    await evictDurableObject(stub)
    await eventually(stub, async (_home, state) => (await state.storage.getAlarm()) === null)
  })

  it("answers a turn cut off by an eviction exactly once, after the alarm", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home, state) => {
      home.script(["hang", "recovered"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "turn-1")
      await home.hanging.promise
      expect(home.harness.wake().active).toBe(true)
      expect(await state.storage.getAlarm()).not.toBeNull()
    })

    await evictDurableObject(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    await runInDurableObject(stub, async (home: Home) => {
      await home.submit("hello", "turn-1")
      await home.harness.waitForIdle(context)
    })
    const entries = await runInDurableObject(stub, async (home: Home) => history(await home.root()))
    expect(texts(entries, "user")).toEqual(["hello"])
    expect(texts(entries, "assistant")).toEqual(["recovered"])
    await eventually(stub, async (_home, state) => (await state.storage.getAlarm()) === null)
  })

  it("runs 10 conversations x 30 subrequesting tool calls inside one invocation", async () => {
    const stub = fresh()
    const threads = 10
    const calls = 30
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const extensions = home.extensions()
      await home.arm({ active: true })
      const created: ConversationId[] = []
      for (let index = 0; index < threads; index++) {
        const conversation = await home.harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL, extensions: [...extensions] } },
          context,
        )
        await conversation.commit(
          (tx) => conversation.submit(tx, { type: "input", content: `ping ${calls}`, requestId: `t${index}` }),
          context,
        )
        created.push(conversation.id)
      }
      await home.harness.waitForIdle(context)
      const results = { ok: 0, failed: 0, answers: [] as string[] }
      for (const id of created) {
        const conversation = await home.harness.conversation(id, context)
        if (conversation === undefined) continue
        for (const entry of await history(conversation)) {
          for (const message of entry.model ?? []) {
            if (message.role === "toolResult") results[message.isError ? "failed" : "ok"]++
          }
        }
        results.answers.push(...texts(await history(conversation), "assistant"))
      }
      return results
    })
    expect(outcome.failed).toBe(0)
    expect(outcome.ok).toBe(threads * calls)
    expect(outcome.answers.filter((answer) => answer === `pinged ${calls}`)).toHaveLength(threads)
  })
})
