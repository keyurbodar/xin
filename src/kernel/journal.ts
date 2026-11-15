import type { Context } from "@earendil-works/chord/context"
import {
  type CommitResult,
  type Cursor,
  type DocumentAddress,
  MemoryStorage,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable"
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"

/** A flush waits for this many bytes of journal before it writes one even without a boundary. */
const FLUSH_BYTES = 1_000_000
/** One journal row holds at most this many bytes of JSON, since a Durable Object caps a row at 2 MB. */
const PART_BYTES = 1_500_000
/** Flushes between checkpoints: a cold start replays at most this many journal slots. */
const CHECKPOINT_ROWS = 256
/** The ring's slots: a checkpoint's worth plus the flushes a failed checkpoint may still store before it is retried. */
const SLOTS = CHECKPOINT_ROWS + 32
const PAGE = 500
/** Tables from before the journal (xi's, imported once) and before its ring (`pi_journal`, replayed once), then dropped. */
const LEGACY_TABLES = [
  "pi_journal",
  "pi_durable_schema",
  "pi_durable_metadata",
  "pi_record_ids",
  "pi_conversations",
  "pi_entries",
  "pi_tasks",
  "pi_submissions",
  "pi_documents",
  "pi_document_revisions",
] as const

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })

type Commit = { readonly seq: Seq; readonly writes: readonly StorageWrite[] }
type Batch = { readonly seq: Seq; readonly commits: readonly Commit[] }
type JournalRow = {
  readonly slot: number
  readonly seq: number
  readonly part: number
  readonly parts: number
  readonly bytes: number
  readonly data: ArrayBuffer | null
}

const bytesOf = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))

/**
 * pi's state in memory, made durable by a journal of its own commits.
 *
 * The harness runs on `MemoryStorage`, so its reads are map lookups and a commit writes one journal row for the whole
 * turn instead of a task row, a document revision and a row per index. A flush happens at a boundary — the turn's
 * answer or a settled submission — so the journal holds at most the turn in flight, or `FLUSH_BYTES` of it.
 *
 * The journal alone would replay forever, so at every `CHECKPOINT_ROWS` flushes it stores the state as one commit of
 * plain `StorageWrite`s. The journal is a ring of `SLOTS` slots that flushes overwrite in turn, so a checkpoint deletes
 * nothing: it only moves the sequence below which a cold start ignores a slot. Every part of a slot carries its flush's
 * sequence, so a stale part a shorter flush left behind is never read as the current one, and a slot is overwritten in
 * one transaction, so a crash leaves either the old flush or the new one.
 *
 * A slot may be overwritten only once a checkpoint covers it. Without a failure a checkpoint runs at every
 * `CHECKPOINT_ROWS` flushes, so at most `CHECKPOINT_ROWS` slots are uncovered and the ring, which is larger, never
 * reaches one. A failed checkpoint restarts the count, so the uncovered slots can grow past it; when all `SLOTS` are
 * uncovered, a flush keeps its commits in memory and the commit retries the checkpoint, which covers them, instead of
 * overwriting a slot. An eviction loses the commits since the last flush, which the turn re-runs: the harness retries an
 * interrupted attempt, and a submission is deduplicated by its request id.
 */
export class JournalStorage extends MemoryStorage {
  readonly #store: DurableObjectStorage
  /** Document id to kind, from the creates this journal saw, so a live-document progress commit is recognised. */
  readonly #kinds = new Map<number, string>()
  #pending: Commit[] = []
  #pendingBytes = 0
  #journalled = 0
  /** Flushes no checkpoint covers yet: a flush may overwrite a slot only while this is below `SLOTS`. */
  #uncovered = 0
  /** The ring slot the next flush overwrites. */
  #slot = 0
  /** The last commit sequence applied, which the checkpoint and an import continue from. */
  #lastSeq = 0
  #live = false
  /** The checkpoint in flight, which a commit waits for so the snapshot and its sequence describe the same state. */
  #checkpointing: Promise<void> | undefined
  /** Resolved while no checkpoint is in flight; a commit awaits it before applying. */
  #gate: Promise<void> = Promise.resolve()

  private constructor(store: DurableObjectStorage) {
    super()
    this.#store = store
  }

  static async open(store: DurableObjectStorage, context: Context): Promise<JournalStorage> {
    const journal = new JournalStorage(store)
    journal.#migrate()
    const legacyJournal = journal.#hasTable("pi_journal")
    const restored = await journal.#restore(legacyJournal)
    if (!restored && journal.#hasTable("pi_conversations")) await journal.#import(context)
    else if (legacyJournal) await journal.checkpoint(context)
    journal.#dropLegacy()
    journal.#live = true
    return journal
  }

  override async commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    context: Context,
  ): Promise<CommitResult> {
    // A checkpoint reads the whole state, so no commit may change it meanwhile: otherwise the snapshot can hold a
    // commit whose sequence the checkpoint recorded earlier, and replaying that commit on a cold start throws.
    while (this.#checkpointing !== undefined) await this.#gate
    const seqs: Seq[] = []
    const result = await super.commit(
      batches,
      (index, seq) => {
        seqs[index] = seq
        receive(index, seq)
      },
      context,
    )
    if (!this.#live || result.stored === 0) return result
    let boundary = false
    let config = false
    for (let index = 0; index < result.stored; index++) {
      const writes = batches[index] ?? []
      const seq = seqs[index] as Seq
      this.#learn(writes)
      this.#pending.push({ seq, writes })
      this.#lastSeq = Math.max(this.#lastSeq, seq)
      this.#pendingBytes += bytesOf(writes).length
      boundary ||= isBoundary(writes)
      config ||= writes.some(
        (write) =>
          (write.type === "document.change" && this.#kinds.get(write.id) !== "pi.live") ||
          (write.type === "document.create" && write.record.kind !== "pi.live"),
      )
    }
    // A commit that changes a document other than the live one is configuration — a model, a thread, a schedule, a
    // project — and is stored at once so an eviction cannot take it. A change to the live document is the streamed
    // answer and waits for the turn's boundary, or a long reply would write a row per second of streaming.
    if (boundary || config || this.#pendingBytes >= FLUSH_BYTES) {
      this.#flush()
      if (this.#journalled >= CHECKPOINT_ROWS || this.#pending.length > 0) {
        // The rows are already durable, so the count restarts before the attempt: a checkpoint that throws must not
        // make every later commit try it again, which would fail each one. Only a full ring, whose flush stayed in
        // memory, retries at every flush, since nothing else can make those commits durable.
        this.#journalled = 0
        await this.checkpoint(context)
      }
    }
    return result
  }

  override async close(context: Context): Promise<void> {
    if (this.#live) {
      this.#flush()
      await this.checkpoint(context)
    }
    await super.close(context)
  }

  /** Store the state and cover the journal slots before it, so a cold start replays at most one checkpoint's worth. */
  checkpoint(context: Context): Promise<void> {
    return (this.#checkpointing ??= this.#writeCheckpoint(context).finally(() => {
      this.#checkpointing = undefined
    }))
  }

  async #writeCheckpoint(context: Context): Promise<void> {
    this.#flush()
    const gate = Promise.withResolvers<void>()
    this.#gate = gate.promise
    try {
      // Captured after the snapshot: with commits gated for its whole length, the sequence and the state it stores
      // are the same point in the journal.
      const writes = await snapshot(this, context)
      const seq = Math.max(this.#lastSeq, 1) as Seq
      const parts = split(bytesOf({ seq, writes }))
      // One transaction: a crash midway must leave the previous checkpoint whole, since its parts are overwritten in
      // place and a part past the new count is left behind for the stored count to ignore.
      this.#store.transactionSync(() => {
        this.#write(
          "INSERT INTO pi_checkpoint (singleton, seq, parts, bytes) VALUES (1, ?, ?, ?) ON CONFLICT (singleton) DO UPDATE SET seq = excluded.seq, parts = excluded.parts, bytes = excluded.bytes",
          [seq, parts.length, parts.reduce((total, part) => total + part.length, 0)],
        )
        for (const [index, part] of parts.entries())
          this.#write(
            "INSERT INTO pi_checkpoint_part (part, data) VALUES (?, ?) ON CONFLICT (part) DO UPDATE SET data = excluded.data",
            [index, part.buffer as ArrayBuffer],
          )
      })
      this.#journalled = 0
      this.#uncovered = 0
      this.#pending = []
      this.#pendingBytes = 0
    } finally {
      gate.resolve()
    }
  }

  /**
   * The journal owns its tables, as pi's own storage owns its tables; the host migration list is for host data. A home
   * from before the ring still has `pi_journal`, which `open` replays, checkpoints and then drops, so a crash before the
   * drop replays rows the checkpoint covers and skips them.
   */
  #migrate(): void {
    this.#write(
      "CREATE TABLE IF NOT EXISTS pi_journal_ring (slot INTEGER NOT NULL, part INTEGER NOT NULL, seq INTEGER NOT NULL, parts INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (slot, part)) WITHOUT ROWID, STRICT",
      [],
    )
    this.#write(
      "CREATE TABLE IF NOT EXISTS pi_checkpoint (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), seq INTEGER NOT NULL, parts INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT",
      [],
    )
    this.#write(
      "CREATE TABLE IF NOT EXISTS pi_checkpoint_part (part INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT",
      [],
    )
  }

  async #restore(legacyJournal: boolean): Promise<boolean> {
    const checkpoint = this.#read<{ seq: number; parts: number; bytes: number }>(
      "SELECT seq, parts, bytes FROM pi_checkpoint WHERE singleton = 1",
      [],
    )[0]
    if (checkpoint !== undefined) {
      const stored = this.#read<{ data: ArrayBuffer }>(
        "SELECT data FROM pi_checkpoint_part WHERE part < ? ORDER BY part",
        [checkpoint.parts],
      )
      const envelope = parse<{ seq: Seq; writes: StorageWrite[] }>(
        join(
          stored.map((row) => row.data),
          checkpoint.bytes,
        ),
      )
      this.prepareCommit(envelope.writes, envelope.seq).apply()
      this.#learn(envelope.writes)
      this.#lastSeq = Math.max(this.#lastSeq, envelope.seq)
    }
    // Slots the checkpoint covers stay in the ring until a flush overwrites them; replaying one would repeat a commit
    // sequence, which MemoryStorage refuses. Their data is not read, only their sequence, which places the next slot.
    // A commit the checkpoint already holds is skipped, never replayed.
    const covered = checkpoint?.seq ?? 0
    const ring = this.#read<JournalRow>(
      "SELECT slot, seq, part, parts, bytes, CASE WHEN seq > ? THEN data END AS data FROM pi_journal_ring",
      [covered],
    )
    const last = ring.reduce<JournalRow | undefined>(
      (newest, row) => (newest === undefined || row.seq > newest.seq ? row : newest),
      undefined,
    )
    if (last !== undefined) this.#slot = (last.slot + 1) % SLOTS
    const legacy = legacyJournal
      ? this.#read<JournalRow>(
          "SELECT -1 AS slot, seq, part, parts, bytes, data FROM pi_journal WHERE seq > ? ORDER BY seq, part",
          [covered],
        )
      : []
    const rows = [...legacy, ...ring.filter((row) => row.seq > covered)].toSorted(
      (left, right) => left.seq - right.seq || left.part - right.part,
    )
    for (const group of groups(rows)) {
      const first = group[0]
      if (first === undefined) continue
      // A slot's parts past its flush's count belong to an older, covered flush, which the filter above dropped.
      const envelope = parse<Batch>(
        join(
          group.map((row) => row.data ?? new ArrayBuffer(0)),
          first.bytes,
        ),
      )
      for (const commit of envelope.commits) {
        if (commit.seq <= covered) continue
        this.prepareCommit(commit.writes, commit.seq).apply()
        this.#learn(commit.writes)
        this.#lastSeq = Math.max(this.#lastSeq, commit.seq)
      }
      this.#journalled += 1
      if (first.slot >= 0) this.#uncovered += 1
    }
    return checkpoint !== undefined || rows.length > 0
  }

  #hasTable(name: "pi_journal" | "pi_conversations"): boolean {
    return this.#read(`PRAGMA table_list('${name}')`, []).length > 0
  }

  /** One-time move of a home's pi tables into the journal, so an upgrade keeps its conversations. */
  async #import(context: Context): Promise<void> {
    const legacy = await openDurableObjectSqliteStorage(this.#store, { prefix: "pi_" })
    try {
      const writes = await snapshot(legacy, context)
      if (writes.length === 0) return
      this.prepareCommit(writes, (this.#lastSeq + 1) as Seq).apply()
      this.#lastSeq += 1
      await this.checkpoint(context)
    } finally {
      await legacy.close(context)
    }
  }

  #dropLegacy(): void {
    for (const table of LEGACY_TABLES) this.#write(`DROP TABLE IF EXISTS ${table}`, [])
  }

  #flush(): void {
    const commits = this.#pending
    const last = commits[commits.length - 1]
    if (last === undefined || this.#uncovered >= SLOTS) return
    this.#pending = []
    this.#pendingBytes = 0
    const parts = split(bytesOf({ seq: last.seq, commits } satisfies Batch))
    const seq: number = last.seq
    const slot = this.#slot
    this.#store.transactionSync(() => {
      for (const [index, part] of parts.entries())
        this.#write(
          "INSERT INTO pi_journal_ring (slot, part, seq, parts, bytes, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (slot, part) DO UPDATE SET seq = excluded.seq, parts = excluded.parts, bytes = excluded.bytes, data = excluded.data",
          [
            slot,
            index,
            seq,
            parts.length,
            parts.reduce((total, chunk) => total + chunk.length, 0),
            part.buffer as ArrayBuffer,
          ],
        )
    })
    this.#slot = (slot + 1) % SLOTS
    this.#uncovered += 1
    this.#journalled += 1
  }

  #learn(writes: readonly StorageWrite[]): void {
    for (const write of writes)
      if (write.type === "document.create") this.#kinds.set(write.record.id, write.record.kind)
  }

  #read<T extends Record<string, SqlStorageValue>>(sql: string, params: SqlStorageValue[]): T[] {
    return this.#store.sql.exec<T>(sql, ...params).toArray()
  }

  #write(sql: string, params: SqlStorageValue[]): void {
    this.#store.sql.exec(sql, ...params).toArray()
  }
}

/**
 * A commit that ends a turn: its submission settled. That commit also ends the run and its task, so one row holds the
 * whole turn and a restored state is never half-finished. A model round that hands over to a tool ends its generation
 * task without settling anything, which is why the settled submission, not the terminal task, is the boundary: a
 * two-tool message runs three model rounds and must still be one row.
 */
function isBoundary(writes: readonly StorageWrite[]): boolean {
  return writes.some(
    (write) => write.type === "submission" && (write.value.status === "done" || write.value.status === "unanswered"),
  )
}

/** Every record the state holds, as the writes that would rebuild it. */
async function snapshot(reader: Storage, context: Context): Promise<StorageWrite[]> {
  const writes: StorageWrite[] = []
  const conversations = await all((cursor) => reader.scanConversations({}, PAGE, cursor, context))
  const tasks = await all((cursor) => reader.scanTasks({}, PAGE, cursor, context))
  const submissions = await all((cursor) => reader.scanSubmissions({}, PAGE, cursor, context))
  for (const conversation of conversations) writes.push({ type: "conversation", value: conversation })
  for (const task of tasks) writes.push({ type: "task", value: task })
  for (const submission of submissions) writes.push({ type: "submission", value: submission })
  const scopes: DocumentAddress["scope"][] = [
    { kind: "session" },
    ...conversations.map((record) => ({ kind: "conversation" as const, conversationId: record.id })),
    ...tasks.map((record) => ({ kind: "task" as const, taskId: record.id })),
  ]
  for (const scope of scopes) {
    for (const record of await all((cursor) => reader.scanDocuments({ scope, at: "current" }, PAGE, cursor, context))) {
      const stored = await reader.document(record.id, "current", context)
      if (stored === undefined) continue
      writes.push({
        type: "document.create",
        record: stored.record,
        content: { kind: "base", version: stored.version, value: stored.value },
      })
    }
  }
  for (const conversation of conversations) {
    const entries = await all((cursor) =>
      reader.scanEntries({ conversationId: conversation.id, order: "ascending" }, PAGE, cursor, context),
    )
    for (const entry of entries) writes.push({ type: "entry", value: entry })
  }
  return writes
}

async function all<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const items: T[] = []
  let cursor: Cursor | undefined
  for (;;) {
    const page = await scan(cursor)
    items.push(...page.items)
    if (page.next === undefined) return items
    cursor = page.next
  }
}

function split(bytes: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (let start = 0; start < bytes.length; start += PART_BYTES) parts.push(bytes.slice(start, start + PART_BYTES))
  return parts.length === 0 ? [new Uint8Array()] : parts
}

function join(parts: readonly ArrayBuffer[], bytes: number): Uint8Array {
  const value = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    const chunk = new Uint8Array(part)
    value.set(chunk, offset)
    offset += chunk.length
  }
  return value
}

function parse<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T
}

function groups(rows: readonly JournalRow[]): JournalRow[][] {
  const grouped: JournalRow[][] = []
  for (const row of rows) {
    const last = grouped.at(-1)
    if (last !== undefined && last[0]?.seq === row.seq) last.push(row)
    else grouped.push([row])
  }
  return grouped
}
