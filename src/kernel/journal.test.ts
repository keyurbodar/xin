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

/** A configuration document larger than one journal part, so its flush spans two parts of a slot. */
const large = (id: number): StorageWrite => ({
  type: "document.create",
  record: { id: id as DocumentId, kind: "xin.workspace", key: String(id), scope: { kind: "session" } },
  content: { kind: "base", version: 1, value: { marker: id, pad: "x".repeat(2_000_000) } },
})

const slotSeqs = (sql: SqlStorage, slot: number): number[] =>
  sql
    .exec<{ seq: number }>("SELECT seq FROM pi_journal_ring WHERE slot = ? ORDER BY part", slot)
    .toArray()
    .map((row) => row.seq)

const failCheckpoints = (sql: SqlStorage): (() => void) => {
  const exec = sql.exec.bind(sql) as (...args: never[]) => unknown
  Object.defineProperty(sql, "exec", {
    configurable: true,
    value: (query: string, ...params: unknown[]) => {
      if (query.startsWith("INSERT INTO pi_checkpoint (")) throw new Error("simulated crash")
      return Reflect.apply(exec, sql, [query, ...params])
    },
  })
  return () => Object.defineProperty(sql, "exec", { configurable: true, value: exec })
}

const clear = (sql: SqlStorage): void => {
  for (const table of ["pi_journal_ring", "pi_checkpoint_part", "pi_checkpoint"]) sql.exec(`DELETE FROM ${table}`)
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
    "INSERT INTO pi_journal_ring (slot, part, seq, parts, bytes, data) VALUES (?, 0, ?, 1, ?, ?)",
    seq,
    seq,
    data.length,
    data.buffer as ArrayBuffer,
  )
}

const ids = async (storage: JournalStorage): Promise<number[]> => {
  const page = await storage.scanConversations({}, 20, undefined, context)
  return page.items.map((item) => item.id)
}

/** The journal slots a cold start replays: those newer than the checkpoint. */
const journalRows = (sql: SqlStorage): number =>
  Number(
    sql
      .exec(
        "SELECT COUNT(*) AS n FROM pi_journal_ring WHERE part = 0 AND seq > coalesce((SELECT seq FROM pi_checkpoint), 0)",
      )
      .one().n,
  )

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
      // The commit applied after the checkpoint's transaction, so its row is newer than the checkpoint and survives.
      expect(journalRows(state.storage.sql), "the checkpoint truncated a commit that landed during it").toBe(1)

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
      await storage.commit([[conversation(301)]], () => undefined, context)
      await storage.checkpoint(context)
      expect(journalRows(sql), "the checkpoint kept the journal row it covers").toBe(0)
      journal(sql, 9, [conversation(302)])
      await storage.checkpoint(context)
      expect(journalRows(sql), "the checkpoint deleted a journal row newer than itself").toBe(1)

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

  it("ignores the stale part a shorter flush leaves when the ring wraps onto a multi-part slot", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      const storage = await JournalStorage.open(state.storage, context)
      await storage.commit([[large(1)]], () => undefined, context)
      expect(slotSeqs(sql, 0), "the large flush did not span two parts").toHaveLength(2)
      for (let id = 2; id <= 330; id++) await storage.commit([[document(id)]], () => undefined, context)

      const [current, stale] = slotSeqs(sql, 0)
      expect(stale, "the wrapped flush did not leave the old second part behind").toBeLessThan(current ?? 0)
      const restored = await JournalStorage.open(state.storage, context)
      expect((await restored.document(1 as DocumentId, "current", context))?.value).toMatchObject({ marker: 1 })
      for (const id of [2, 256, 257, 289, 330])
        expect(await restored.document(id as DocumentId, "current", context), `document ${id}`).toBeDefined()
    })
  })

  it("restores a checkpoint and replays the slots after it", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      const storage = await JournalStorage.open(state.storage, context)
      for (let id = 1; id <= 300; id++) await storage.commit([[document(id)]], () => undefined, context)
      expect(journalRows(sql), "the slots after the checkpoint").toBe(44)

      const restored = await JournalStorage.open(state.storage, context)
      for (let id = 1; id <= 300; id++)
        expect(await restored.document(id as DocumentId, "current", context), `document ${id}`).toBeDefined()
      await restored.commit([[document(301)]], () => undefined, context)
      const [next, previous] = sql
        .exec<{ slot: number }>("SELECT slot FROM pi_journal_ring ORDER BY seq DESC LIMIT 2")
        .toArray()
        .map((row) => row.slot)
      expect(next, "the reopened journal did not continue after its last slot").toBe((previous ?? 0) + 1)
    })
  })

  it("holds a flush in memory instead of overwriting a slot no checkpoint covers", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home, state) => {
      const sql = state.storage.sql
      clear(sql)
      const storage = await JournalStorage.open(state.storage, context)
      const restore = failCheckpoints(sql)
      for (let id = 1; id <= 288; id++)
        await storage.commit([[document(id)]], () => undefined, context).catch(() => undefined)
      expect(journalRows(sql), "every slot is uncovered").toBe(288)
      await expect(storage.commit([[document(289)]], () => undefined, context)).rejects.toThrow("simulated crash")
      expect(slotSeqs(sql, 0), "a flush overwrote an uncovered slot").toEqual([1])
      restore()
      await storage.commit([[document(290)]], () => undefined, context)

      const restored = await JournalStorage.open(state.storage, context)
      for (const id of [1, 288, 289, 290])
        expect(await restored.document(id as DocumentId, "current", context), `document ${id}`).toBeDefined()
    })
  })
})
