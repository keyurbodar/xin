import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, ConversationId, EntryRecord } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { eventually, fresh } from "../test/support.ts"
import { FAUX_MODEL, type Home } from "../test/worker.ts"
import { HEARTBEAT_MS } from "./host.ts"

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

const heartbeatCleared = async (_home: Home, state: DurableObjectState): Promise<boolean> => {
  const alarm = await state.storage.getAlarm()
  return alarm === null || alarm > Date.now() + HEARTBEAT_MS
}

describe("Home host loop", () => {
  it("runs migrations once and keeps the heartbeat alarm only while work can run", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      const rows = await home.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
      )
      expect(rows).toEqual([{ name: "kv" }])
    })
    await evictDurableObject(stub)
    await eventually(stub, heartbeatCleared)
  })

  it("leaves no table without a reader in the schema", async () => {
    const stub = fresh()
    const tables = await runInDurableObject(stub, async (_home, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((row) => row.name),
    )
    expect(tables).toContain("market_indexes")
    expect(tables).not.toContain("plugins")
    expect(tables).not.toContain("market_versions")
    expect(tables).not.toContain("market_checks")
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
    await eventually(stub, heartbeatCleared)
  })

  it("answers a repair route when its journal cannot be read, then opens once it is dropped", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["noted"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "repair-1")
      await home.harness.waitForIdle(context)
    })
    await runInDurableObject(stub, async (_home, state) => {
      const data = new Uint8Array([0xff, 0xfe, 0x00])
      state.storage.sql.exec(
        "INSERT INTO pi_journal (seq, part, parts, bytes, data) VALUES (?, 0, 1, ?, ?)",
        999_999,
        data.length,
        data.buffer,
      )
    })
    await evictDurableObject(stub)

    const failed = await stub.fetch("https://xin.test/v1/status")
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: "boot_failed" })

    const report = await stub.fetch("https://xin.test/v1/repair")
    expect(report.status).toBe(200)
    const diagnosis = await report.json<{ failure: string | null; journal: number }>()
    expect(diagnosis.failure).toEqual(expect.any(String))
    expect(diagnosis.journal).toBeGreaterThan(0)

    const repaired = await stub.fetch(
      new Request("https://xin.test/v1/repair", { method: "POST", body: JSON.stringify({ drop: "journal" }) }),
    )
    expect(repaired.status).toBe(200)
    expect(await repaired.json()).toMatchObject({ failure: null, journal: 0 })

    const opened = await stub.fetch("https://xin.test/v1/status")
    expect(opened.status).toBe(200)
  }, 30_000)

  it("refuses to drop the journal of a home that is open", async () => {
    const stub = fresh()
    await runInDurableObject(stub, (home: Home) => home.root())
    const reply = await stub.fetch(
      new Request("https://xin.test/v1/repair", { method: "POST", body: JSON.stringify({ drop: "journal" }) }),
    )
    expect(reply.status).toBe(409)
  })

  it("runs 10 conversations x 30 subrequesting tool calls inside one invocation", async () => {
    const stub = fresh()
    const threads = 10
    const calls = 30
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const extensions = [home.extension("tool-test-ping")]
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
