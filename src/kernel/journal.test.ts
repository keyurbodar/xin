import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, Seq, StorageWrite } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { fresh } from "../../test/support.ts"
import { JournalStorage } from "./journal.ts"

const context = BACKGROUND_CONTEXT
const encoder = new TextEncoder()

const conversation = (id: number): StorageWrite => ({ type: "conversation", value: { id: id as ConversationId } })

const clear = (sql: SqlStorage): void => {
  for (const table of ["pi_journal", "pi_checkpoint_part", "pi_checkpoint"]) sql.exec(`DELETE FROM ${table}`)
}

const checkpoint = (sql: SqlStorage, seq: number, writes: readonly StorageWrite[]): void => {
  const data = encoder.encode(JSON.stringify({ seq, writes }))
  sql.exec("INSERT INTO pi_checkpoint (singleton, seq, parts, bytes) VALUES (1, ?, 1, ?)", seq, data.length)
  sql.exec("INSERT INTO pi_checkpoint_part (part, data) VALUES (0, ?)", data.buffer as ArrayBuffer)
}

const journal = (sql: SqlStorage, seq: number, writes: readonly StorageWrite[]): void => {
  const data = encoder.encode(JSON.stringify({ seq, commits: [{ seq, writes }] }))
  sql.exec(
    "INSERT INTO pi_journal (seq, part, parts, bytes, data) VALUES (?, 0, 1, ?, ?)",
    seq,
    data.length,
    data.buffer as ArrayBuffer,
  )
}

const ids = async (storage: JournalStorage): Promise<number[]> => {
  const page = await storage.scanConversations({}, 20, undefined, context)
  return page.items.map((item) => item.id)
}

describe("the journal", () => {
  it("skips journal rows a checkpoint already covers", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      checkpoint(sql, 7, [conversation(101)])
      journal(sql, 7, [conversation(101)])

      const restored = await JournalStorage.open(state.storage, context)
      expect(await ids(restored)).toEqual([101])
    })
  })

  it("keeps the previous checkpoint when a checkpoint write fails", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      const storage = await JournalStorage.open(state.storage, context)
      storage.prepareCommit([conversation(202)], 1 as Seq).apply()
      await storage.checkpoint(context)
      storage.prepareCommit([conversation(203)], 2 as Seq).apply()

      const exec = sql.exec.bind(sql) as (...args: never[]) => unknown
      let failed = false
      Object.defineProperty(sql, "exec", {
        configurable: true,
        value: (query: string, ...params: unknown[]) => {
          if (!failed && query.startsWith("INSERT INTO pi_checkpoint (")) {
            failed = true
            throw new Error("simulated crash")
          }
          return Reflect.apply(exec, sql, [query, ...params])
        },
      })
      await expect(storage.checkpoint(context)).rejects.toThrow("simulated crash")
      Object.defineProperty(sql, "exec", { configurable: true, value: exec })

      const restored = await JournalStorage.open(state.storage, context)
      expect(await ids(restored)).toEqual([202])
    })
  })
})
