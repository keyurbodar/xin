import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, DocumentId, Seq, StorageWrite } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { fresh } from "../../test/support.ts"
import { JournalStorage } from "./journal.ts"

const context = BACKGROUND_CONTEXT
const encoder = new TextEncoder()

const conversation = (id: number): StorageWrite => ({ type: "conversation", value: { id: id as ConversationId } })

/** A configuration document, which the journal flushes at once instead of waiting for a turn boundary. */
const document = (id: number): StorageWrite => ({
  type: "document.create",
  record: {
    id: id as DocumentId,
    kind: "xin.workspace",
    key: String(id),
    scope: { kind: "session" },
  },
  content: { kind: "base", version: 1, value: { marker: id } },
})

const clear = (sql: SqlStorage): void => {
  for (const table of ["pi_journal", "pi_checkpoint_part", "pi_checkpoint"]) sql.exec(`DELETE FROM ${table}`)
}

const checkpoint = (sql: SqlStorage, seq: number, writes: readonly StorageWrite[]): void => {
  const data = encoder.encode(JSON.stringify({ seq, writes }))
  sql.exec("INSERT INTO pi_checkpoint (singleton, seq, parts, bytes) VALUES (1, ?, 1, ?)", seq, data.length)
  sql.exec("INSERT INTO pi_checkpoint_part (part, data) VALUES (0, ?)", data.buffer as ArrayBuffer)
}

const journal = (sql: SqlStorage, seq: number, writes: readonly StorageWrite[]): void =>
  journalRow(sql, seq, [{ seq: seq as Seq, writes }])

const journalRow = (
  sql: SqlStorage,
  seq: number,
  commits: readonly { readonly seq: Seq; readonly writes: readonly StorageWrite[] }[],
): void => {
  const data = encoder.encode(JSON.stringify({ seq, commits }))
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

  it("replays only the commits a later journal row adds to a covered checkpoint", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      checkpoint(sql, 7, [conversation(101)])
      journalRow(sql, 8, [
        { seq: 7 as Seq, writes: [conversation(101)] },
        { seq: 8 as Seq, writes: [conversation(102)] },
      ])

      const restored = await JournalStorage.open(state.storage, context)
      expect(await ids(restored)).toEqual([101, 102])
    })
  })

  it("keeps a commit that lands during a checkpoint out of its snapshot", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      clear(state.storage.sql)
      const storage = await JournalStorage.open(state.storage, context)
      await storage.commit([[conversation(401)]], () => undefined, context)

      const checking = storage.checkpoint(context)
      await storage.commit([[document(402)]], () => undefined, context)
      await checking

      const restored = await JournalStorage.open(state.storage, context)
      expect(await ids(restored)).toEqual([401])
      expect(await restored.document(402 as DocumentId, "current", context)).toBeDefined()
    })
  })

  it("keeps committing after a checkpoint fails", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      const storage = await JournalStorage.open(state.storage, context)

      const exec = sql.exec.bind(sql) as (...args: never[]) => unknown
      let failed = false
      Object.defineProperty(sql, "exec", {
        configurable: true,
        value: (query: string, ...params: unknown[]) => {
          if (query.startsWith("INSERT INTO pi_checkpoint (")) {
            failed = true
            throw new Error("simulated crash")
          }
          return Reflect.apply(exec, sql, [query, ...params])
        },
      })
      // The row that reaches the checkpoint threshold fails it, and the checkpoint keeps failing: the next commit
      // must still succeed instead of trying the checkpoint again.
      for (let id = 1; id <= 255; id++) await storage.commit([[document(id)]], () => undefined, context)
      await expect(storage.commit([[document(256)]], () => undefined, context)).rejects.toThrow("simulated crash")
      expect(failed).toBe(true)
      await storage.commit([[document(999)]], () => undefined, context)
      Object.defineProperty(sql, "exec", { configurable: true, value: exec })

      const restored = await JournalStorage.open(state.storage, context)
      expect(await restored.document(999 as DocumentId, "current", context)).toBeDefined()
    })
  })

  it("truncates only the journal rows the checkpoint covers", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      const storage = await JournalStorage.open(state.storage, context)
      storage.prepareCommit([conversation(301)], 1 as Seq).apply()
      await storage.checkpoint(context)
      journal(sql, 9, [conversation(302)])
      await storage.checkpoint(context)

      const restored = await JournalStorage.open(state.storage, context)
      expect(await ids(restored)).toEqual([301, 302])
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
