# How Kiko handles Durable Objects, and what Xin should take

Read against Kiko at [`82906df0`](https://github.com/keyurbodar/kiko/tree/82906df00fd665fdb9b99a267b175d8db127a873) (2026-11-01). Every number below was measured, not read off a comment: Kiko's own write-budget test, plus the integration probe kept at `docs/study/kiko-meter.integration.test.ts` run against the real Worker in `wrangler dev` (`apps/server/integration/worker.ts` harness, `GET /api/dev/stats`, which reports the `cursor.rowsRead` / `cursor.rowsWritten` counters Cloudflare bills).

Xin's baseline, from the pre-journal measurement that prompted this study (2026-11-09): **182 rows written and 229 rows read per message** in the `Home` Durable Object. The harness in §15 measured **99 written / 130 read** for one message and one reply with no tools on the commit this study landed on, so treat 182 as a heavier turn — tools, delegation, streaming partials — and use the harness, not the quoted number, for before and after. The journal (`src/kernel/journal.ts`) has since moved both to **16 written / 21 read** per message, and §14 records the update; the numbers below are the reading this study was written against.

## 1. The headline

| | Xin today | Kiko, warm prompt |
|---|---|---|
| Rows written per message | 182 | **6** (5 SQL + 1 `setAlarm`) |
| Rows read per message | 229 | **4,094** at 22 messages, **331,316** at 324 messages |

Kiko did not solve write amplification so much as move it. Its write path is close to the floor a Cloudflare DO allows. Its read path is quadratic in chat length, and that — not writes — is what produced the 99% quota warning: the Workers Free plan allows **100,000 rows written but 5,000,000 rows read per day** ([Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)), so a few hundred reads per message is comfortable and 331,316 is not.

Adopt the write techniques. Do not adopt the read habits, and add the compaction Kiko omitted.

Measured with Kiko's dev meter, per prompt, fake agent, one human message and one reply:

```text
### small prompt at 22 messages: 6 writes, 4094 reads
-- top reads --
  1638  SELECT ? FROM sqlite_master WHERE type = ? AND name = ?        (repeated table-existence checks)
   355  SELECT (SELECT count(*) FROM messages WHERE room_id = ? ... )   (unread count)
   339  SELECT m.text, r.sender ... FROM messages ...                   (reply previews)
   253  SELECT id FROM messages WHERE room_id = ? AND run_id = ? ...    (run bookkeeping)
   253  SELECT MAX(run_attempt) AS attempt FROM (SELECT * FROM messages WHERE room_id = ?) WHERE run_id = ?
   242  SELECT run_attempt AS attempt, max(run_index) + ? AS posted FROM messages WHERE room_id = ? ...
   232  SELECT id, seq, text FROM (SELECT * FROM messages WHERE room_id = ?) WHERE run_id = ?
-- top writes --
     2  INSERT INTO messages (...)                                      (human message + reply)
     1  INSERT INTO journal (agent, seq, part, parts, bytes, data)
     1  INSERT INTO owner_runs (...) ON CONFLICT(agent) DO UPDATE ...
     1  DELETE FROM owner_runs WHERE agent = ? AND version = ?
     1  setAlarm

### big prompt at 324 messages: 8 writes, 331316 reads
 54111  unread count
 53944  reply previews
 52650  SELECT id FROM messages WHERE room_id = ? AND run_id = ? AND run_attempt < ? ...
 52650  SELECT MAX(run_attempt) ... FROM (SELECT * FROM messages WHERE room_id = ?) ...
 52488  SELECT run_attempt ..., max(run_index) + ? ... FROM messages WHERE room_id = ? ...
 52327  SELECT id, seq, text FROM (SELECT * FROM messages WHERE room_id = ?) WHERE run_id = ?
  5494  SELECT * FROM mem_turns WHERE room_id = ? ORDER BY pos
  1638  sqlite_master checks
```

Kiko's own gate agrees on writes: `apps/server/integration/journal-overhead.integration.test.ts` fails if the median warm prompt writes more than `ROW_GATE = 7` billable rows, asserts a quiet minute writes **0**, and asserts there are no calls between objects.

## 2. Shape: one Durable Object class

`apps/server/wrangler.jsonc` declares exactly one class:

```jsonc
"durable_objects": { "bindings": [{ "name": "OWNER", "class_name": "OwnerDO" }] },
"migrations": [{ "tag": "v5", "new_sqlite_classes": ["OwnerDO"] }],
```

`lib/names.ts` gives each owner one instance, `ns.idFromName("owner:" + userId)`. Two more DO classes exist in the platform, not in the product: `Installer` (`apps/installer`) and `Builder` (`apps/builder`, a separate Worker because its 14 MB esbuild wasm would otherwise compile on every cold start).

Inside `OwnerDO`, rooms, agents, the user, files and the clock are **plain classes over one SQLite database**, not objects:

```ts
private readonly rooms = new Map<string, Room>()
private readonly agents = new Map<string, Agent>()
```

That is the structural decision everything else follows from. Delegation, messaging and the run queue are method calls; the write-budget test asserts zero inter-object RPC, so a run never pays for a second hop, a serialization, or a second object's alarm.

Xin already matches this (one `Home` per owner). The difference is entirely *how* the harness persists inside it.

## 3. What is in SQL tables and what is in KV

Almost everything is SQL, with no secondary indexes beyond primary keys.

`apps/server/src/owner/schema.ts`:

```sql
CREATE TABLE messages (
  room_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
  sender TEXT NOT NULL, text TEXT NOT NULL, rich TEXT, reply_to TEXT, files TEXT,
  run_id TEXT, run_attempt INTEGER, run_index INTEGER, ...,
  client_id TEXT, message_payload TEXT, mentions TEXT, run_steps_log TEXT,
  PRIMARY KEY (room_id, seq)
) WITHOUT ROWID, STRICT
```

There is no `CREATE INDEX` on `messages` at all: `messages_id` and `messages_run` were created early and then **dropped** by later migration steps, because the id is derivable from the seq (`<seq>.<hex room>`, `core/protocol` `messageIdAt`/`messageSeq`) and run lookups are meant to be rare. `events` (non-message events only), `reactions`, `owner_meta (scope, key, value)`, `owner_runs` (the run queue), `members`, `ws_tasks`, `agent_sends`, `history_archive_*`, plus the user side (`settings`, `life`, `reminders`, `capture_queue`, `user_events`, `credentials`, `computers`, `apps`).

KV (`ctx.storage.put/get`) is used only for a handful of agent-level scalars that do not deserve a table — `memory:pos`, `memory:life`, `memory:revision`, `usage:carried`, `compactions`, `model:applied` — and, behind a prefixing proxy, as pi's `Storage` interface for the harness:

```ts
// apps/server/src/agent/storage.ts
export function agentStorage(storage: DurableObjectStorage, key: string, clock: ClockPort): DurableObjectStorage
```

This is worth stating plainly because it is a common misreading of the design: **KV is not cheaper.** Cloudflare bills `put`/`get`/`delete`/`list` as rows read and written out of the same hidden SQLite table. Kiko uses KV to avoid a table, not to avoid a row.

The one thing SQL is deliberately *not* used for is the transcript of a run: that is a journal blob (§5).

## 4. One message, end to end

1. Client sends over the socket; `OwnerDO.webSocketMessage` dispatches RPC.
2. `Room.humanSend` → `storeSend` runs one `transactionSync`: idempotency check (`sentBefore(clientId)` looks only at the last 200 rows), then `log.addMessage(...)` writes **one** `messages` row containing `message_payload`, the fully rendered wire event, so replay never re-renders.
3. `publish(events)` broadcasts to sockets, touches the user's chat projection, and calls `burst.arm(text)`.
4. The burst debounces (`AFTER_MESSAGE_MS = 1_000`, capped by `MAX_BURST_MS = 30_000`) and stores its deadline in the clock metadata row; the alarm fires.
5. `flushBurst` → `receive` → the agent's harness runs; the agent writes its turn as **one** `journal` row per flush boundary (§5) and its reply bubbles as `messages` rows.
6. Admission is one row: `owner_runs` upserted before the run and deleted after it.

```ts
// apps/server/src/owner/owner-do.ts
sql.exec(`INSERT INTO owner_runs (agent, room_id, slug, request_id, ready_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent) DO UPDATE SET ready_at = min(owner_runs.ready_at, excluded.ready_at), version = owner_runs.version + 1`)
...
finally { sql.exec("DELETE FROM owner_runs WHERE agent = ? AND version = ?", ...) }
```

Cost for one human message, one reply, no tools: **2 message rows + 1 journal row + 1 `owner_runs` insert + 1 `owner_runs` delete + 1 `setAlarm` = 6** (measured: 5 SQL + 1 alarm). With three tool rounds the gate allows `7 + 2 x (3-1) = 11`; each extra round is the assistant/tool entry pair inside the same journal. Tool *step cards* cost nothing extra: `RunSteps` keeps them in a `Map` while the run is open and `RoomLog.addMessage` writes them once, capped at `STEP_LOG_BYTES = 128 * 1024`, into `messages.run_steps_log`.

For comparison, Xin's per-message cost is dominated by pi's SQLite storage: each `StorageWrite` becomes a table row **plus** a `record_ids` row **plus** one row per matching index, and every commit additionally does `UPDATE durable_metadata SET next_id = ?, next_seq = ?`. `entries` carries 2 indexes, `tasks` 5, `submissions` 3, `documents` 3, `document_revisions` 1. That is how ~38 logical changes become ~180 billed rows.

## 5. The big one: pi's storage replaced by a batched journal

Kiko does **not** use `openDurableObjectSqliteStorage`. It runs the same pi-durable `Harness` on `MemoryStorage` and persists a journal of `StorageWrite` envelopes:

```ts
// core/agent/src/journal.ts
export class JournalStorage extends MemoryStorage {
  override commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    return this.serial(async () => {
      const prepared = this.prepareCommit(writes)
      const seq = prepared.apply()          // applied in memory, immediately visible
      const envelope = { seq, writes: prepared.writes }
      this.pending.push(envelope)
      this.pendingBytes += encoder.encode(JSON.stringify(envelope)).length
      const boundary = prepared.writes.some(
        (write) =>
          (write.type === "entry" && write.value.model?.some((m) => m.role === "assistant")) ||
          (write.type === "submission" && (write.value.status === "done" || write.value.status === "unanswered")),
      )
      if (boundary || this.pendingBytes > BATCH_BYTES) this.flush()
      this.observeIds(prepared.writes, prepared.seq)
      return seq
    })
  }
```

- `PART_BYTES = 1_500_000`, `BATCH_BYTES = 1_000_000`: the whole turn is serialized to one JSON blob, split only at 1.5 MB (the DO row limit is 2 MB).
- **Flush only at a semantic boundary**: an assistant entry or a settled/queued submission. Token deltas, tool partials, live-doc churn and task state transitions can commit a hundred times and write nothing.
- Replay is the inverse: `JournalStorage.open` reads `SELECT seq, part, parts, bytes, data FROM journal WHERE agent = ? ORDER BY seq, part` and calls `prepareCommit(writes, seq).apply()` for each envelope, rebuilding the in-memory store.
- Ids are leased in blocks of `ID_RANGE = 1024`, so `journal_ids` is updated once per 1024 mints, not per id.
- A schema for the journal is two tables: `journal (agent, seq, part, parts, bytes, data)` and `journal_ids`.

The result: an entire model turn — user entry, assistant entry with reasoning, every tool call and result, task transitions, doc changes — costs **1 row**. That is the technique that actually gets Xin from 182 to single digits.

Xin's pi-durable is 1.5.0, one minor version past Kiko's 1.3.0, and the shape is the same but the seam is wider: 1.5.0's `Storage.commit` already accepts *batches* (`commit(batches, receive, context)`), and `MemoryStorage.prepareCommit(writes, seq?)` still returns `{ seq, writes, apply() }`. So a Xin adapter can persist a whole `commit` call, however many batches it carries, as one envelope — the work is writing it against 1.5.0's signature rather than copying Kiko's 1.3.0 override.

Two caveats, both visible in Kiko:

- `open` replays **everything**. There is no compaction except `JournalStorage.reset` on a context rollover (`core/agent/src/host.ts` → `rollover`, which first parks the last input in `agent_handoff`). A long-lived agent's cold start reads its whole history: rows, bytes and CPU all grow with age.
- The blob duplicates what the rendered message already holds (the reply text exists in both `messages.text` and the journal), so storage grows faster than the row count suggests.

Xin should take this shape **with** a compaction step: after replaying, write a checkpoint that folds the journal into a snapshot and truncates the prefix, then replay from the checkpoint.

## 6. Everything Kiko coalesces, in one list

| Technique | Where | What it removes |
|---|---|---|
| One message row holds the rendered wire payload | `room/log.ts` `insertMessage` | a second `events` row per message and re-rendering on replay |
| Run steps in memory, flushed once onto the message | `room/steps.ts`, `run_steps_log` | one row per tool step |
| Derived message ids, no id/run indexes | `message-position.ts`, dropped indexes | 1-2 index rows per message |
| Delivery cursors derived from the journal (`humanDeliveredSeq`) | `core/agent/src/journal.ts`, `room/burst.ts` | a per-agent read-cursor row per delivery |
| Run queue is one row, upserted then deleted | `owner_runs` | a job/ticket table |
| Burst debounce in one `owner_meta` clock row | `owner/clock.ts` | a timer row per message |
| `ON CONFLICT ... WHERE value IS NOT excluded.value` everywhere | `owner/context.ts` `metadata.set`, `lib/settings.ts`, `RoomLog.setMeta` | rewrites of unchanged values |
| Agent status in a `Map`, not a column | `room/members.ts` | a row per running/idle/typing flip |
| Socket cursor in the WebSocket attachment | `rpc/subscriptions.ts`, `owner/socket.ts` | a cursor row per stream tick |
| Steps/cards/attachments in memory until the bubble lands | `room/bubbles.ts` | per-token writes |
| FTS in chunks, built on first search, refreshed by edit only | `room/search.ts` | per-message FTS writes (measured: 2 writes for the first search, 0 for the second) |
| Cold history to R2 as gzipped JSONL, one object per room-day, 30-day hot window | `owner/history-archive.ts`, `owner/archive.ts` | unbounded `messages` growth |
| Retention prunes by age and by replay window (`KEEP_SENDS_MS`, `KEEP_EVENTS`, `archived_unread`) | `room/messaging.ts`, `room/log.ts` | table growth |
| Write budget enforced by a test with a hard gate | `journal-overhead.integration.test.ts` | regressions |

## 7. Alarms and the clock

One alarm for the whole owner. `Clock.refresh()` takes a snapshot of everything that could need the object — loaded agents' pi task deadlines, unloaded agents' stored deadlines, the earliest queued run, the burst debounce — and arms the minimum:

```ts
// apps/server/src/owner/clock.ts
const current = await this.storage.getAlarm()
if (next === undefined) { if (current !== null) await this.storage.deleteAlarm() }
else if (current !== next) await this.storage.setAlarm(next)
```

- Refreshes are serialized through a promise chain (`this.update`) so concurrent calls cannot arm a stale value.
- A service's deadlines are one JSON object in one `owner_meta` row per scope (`clock:application`), so ten wakeups cost one row; `change()` compares `before`/`after` and skips the write when nothing moved.
- `runDue` clears a key only if its deadline did not move while the handler ran, so a handler that re-armed itself is not clobbered.
- **No heartbeat.** Recovery is instead a 60 s delay (`RECOVERY_DELAY_MS`) attached to unfinished tasks: the alarm is a *deadline*, not a liveness ping. Measured: a quiet minute writes 0 rows and makes 0 `setAlarm` calls; three idle seconds read and write nothing.
- Errors are contained: the alarm loops over due scopes with a per-scope `try/catch`, and any failure ends in `refreshClock` so the next deadline is still armed.

This is directly actionable for Xin, whose `src/kernel/clock.ts` arms `now + HEARTBEAT_MS` (60 s) whenever `wake.active` and calls `setAlarm` unconditionally on every arm. That is one billed row per event that touches the host, plus an alarm invocation per minute while active.

## 8. What lives in memory across requests

- `rooms: Map<roomId, Room>` — every Room ever touched. Its `RoomLog` keeps the open step window per agent (`windows`, `RunSteps.running/cards`), `Members.statuses`, `MessageChains.chains`, `Burst.durable/admitted` cursors, the memory capture cache.
- `agents: Map<key, Agent>` — LRU-ordered, and `trimAgents()` unloads down to **8 loaded** agents on every alarm. The harness's whole state is the in-memory `MemoryStorage`; unloading is free because replay is deterministic.
- `settings?: User` — one `User` per instance.
- Dev-only counters.

The asymmetry matters: agents are bounded (8), **rooms are not**. `this.rooms` has no eviction path (`grep 'rooms.delete'` finds nothing), so a long-lived object with many chats holds every Room and its caches forever. Xin should bound both.

## 9. Eviction and restart

Everything that must survive is already keyed to be replayable:

1. Constructor: `initializeSchema(ctx.storage)` (idempotent migration list), then `restoreOverlay`/`restoreCustom`, then the clock and services are built. No `blockConcurrencyWhile` is needed because the constructor is synchronous and the schema is applied before any event.
2. On the first socket: `resumeSocket()` reads `DISTINCT agent FROM journal` and asks each agent `unfinished()`. A run that was cut off is re-queued as a `recovery` run; pending human input is settled.
3. On the last socket closing: `recoverDisconnected()` re-queues unfinished runs with `Date.now() + RECOVERY_DELAY_MS`, so a crash with no tab open still finishes work, but not in a tight loop.
4. The alarm reaches stored deadlines for agents that were evicted and never reloaded, using `json_each` over `owner_meta`.
5. `agent_handoff` carries the last input across a journal rollover/reset, so a compaction cannot lose the message that triggered it.
6. Client reconnects replay from the cursor in the socket attachment: a waking tab resubscribes from where it was and the server replays only what it missed, while the cursor itself costs no row (`ARCHITECTURE.md`: "the cursor rides in the socket attachment ... bills nothing").

## 10. Deliberate cost measures

- The write-budget integration test is the only reason the numbers stay honest: median ≤ 7 rows for a warm prompt, 0 in the quiet minute, ≤ 11 for three tool rounds, exactly one error row for a failing prompt.
- Row counters come from `cursor.rowsRead` / `cursor.rowsWritten` — the *billing* counters — not `total_changes()`. The instrumentation is patched into `sql.exec` and every storage KV method only under `NODE_ENV=development`.
- Run budget: 40 outbound calls per run, 12 min wall clock, yield after 3 calls when another agent is queued. That is a subrequest-quota measure, not a row measure.
- Caps everywhere: `STEP_LOG_BYTES`, `MAX_ENTRY_BYTES`, `MAX_DELIVERY_ENVELOPES`, `MAX_MEMBERS = 8`, `MAX_ROOM_STREAMS = 32`, `SNAPSHOT_MESSAGES = 200`, `REPLAY_LIMIT = 500`, `KEEP_EVENTS = 1000`, retention windows.

## 11. What Kiko gets wrong, including the 99% warning

**The read path is quadratic.** `message-position.ts` defines

```ts
export const RECENT_MESSAGES = "(SELECT * FROM messages WHERE room_id = ?)"
```

and `Bubbles.post`, `Bubbles.settle`, `Bubbles.ended` and `Outbox` each wrap it in an aggregate, so every bubble scans every message in the room. With the run bookkeeping (`earlierAttempts`, `MAX(run_attempt)`, `max(run_index)`) and the unread count and reply previews, a prompt at 324 messages reads 331,316 rows. The growth is quadratic: extrapolating that shape to ~1,000 messages gives ~3M reads, so one message would consume 60% of the daily free read allowance. **This is the most likely source of the 99% quota warning**: the app was almost certainly fine on writes (100k/day = ~16,000 messages at 6 rows) and far over on reads (5M/day = ~15 prompts at 320 messages).

**Schema checks on the hot path.** `room/members.ts` and `room/workspace.ts` run `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?` on every read path. Measured 1,638 rows read per prompt, and the cost grows as the schema grows. Cache it.

**The journal never compacts.** Replay reads every row of every agent's journal on every cold start, and the blobs hold full model transcripts. Nothing deletes them except a context rollover.

**Rooms are never evicted** (§8).

**No production meter.** `patchStorage` is development-only, and nothing records rows read/written in production. The owner cannot see what is consuming the quota, which is exactly why a 99% warning arrives as a surprise. Xin has `usage_daily` for tokens and should put rows next to it.

**And the measurement trap that probably hides Xin's own number from Xin.** `src/cost.test.ts` measures with `SELECT total_changes()`, which counts table rows and **not** index rows; Cloudflare bills an index row per written index. Verified in `bun:sqlite`: an insert into a table with two indexes reports `total_changes() = 1` and is billed as 3 rows. So Xin's documented "38 rows, bound 60" is a table-row count, not a billed count — its billed number is the 182 that was measured through the platform. Any gate Xin writes must use `rowsWritten`/`rowsRead`, as Kiko's does.

## 12. Ranked: what to adopt, by rows saved per message

Estimates start from Xin's 182, or from the 99 the harness measures for a no-tool turn, and attribute the pi-storage share by write type (table row + `record_ids` + indexes + `durable_metadata`). They are order-of-magnitude, not promises.

| # | Technique | Expected saving (rows/message) | Risk / work |
|---|---|---|---|
| 1 | **Batched journal instead of pi SQL tables** in the agent/kernel path: `MemoryStorage` subclass, flush at assistant/settled boundaries or 1 MB, one `journal` row per turn, replay on open, **plus compaction** | **~110-150** (a turn becomes 1-2 rows) | Medium-high: a storage adapter inside the `pi` kernel row, deterministic replay, a checkpoint+truncate step Kiko lacks |
| 2 | **Drop secondary indexes; derive ids from seq** (`<seq>.<hex>`, `PRIMARY KEY (room_id, seq)`) | **~30-50**: 3-5 index rows per pi write, 2 per `inbound` status flip | Low-medium: rewrite lookups that assume an id index |
| 3 | **One row per message with the rendered payload; steps folded into that row** | **~10-30** on tool-heavy turns | Low: changes `events`/`run_steps` usage, not the model path |
| 4 | **Intake without a 3-state durable row**: receipt derived from the message's `client_id`, delivery cursor derived from the conversation, one queue row inserted and deleted per run | **~8-12** | Low: the idempotency keys already exist in `docs/plan/architecture/02-state.md` |
| 5 | **Derive the alarm; no heartbeat** (one metadata row per scope, arm only on change, delete when idle) | **~2-4** writes, and one fewer request per active minute | Low |
| 6 | **Write only on change** (`WHERE value IS NOT excluded.value`) for `kv`, meta and cursors | **~2-5** | Trivial |
| 7 | **Ephemeral state in memory / socket attachment** (run status, stream cursor, open step cards) | **~2-6** | Low; needs the same "replay rebuilds it" discipline |
| 8 | **Lazy chunked FTS** instead of per-row triggers | **~1-3** at personal scale; large with edits and backfill | Medium: search becomes a build step |
| 9 | **Cold history to R2 by day, 30-day hot window** | 0 rows/message; bounds storage and snapshot cost | Low-medium |

Items 1-4 together are what "a couple of rows" requires; any one alone lands at 40-140. Kiko's 6 is 2 message rows + 1 journal row + 2 queue rows + 1 alarm, which is the floor this design can reach.

## 13. What to skip

- **`SELECT * FROM messages WHERE room_id = ?` as a subquery constant.** Keep `(room_id, run_id, run_attempt, run_index)` indexed, or hold in-flight run state in memory the way Kiko holds step cards. Read amplification is a quota failure too, and it grows with the history a personal agent is supposed to accumulate.
- **`sqlite_master` checks per call.** Resolve table existence once per instance.
- **Unbounded journal replay.** Take the journal, add compaction (checkpoint + truncate), and keep the partition size small.
- **Unbounded `rooms` cache.** Bound it like `agents` (8).
- **Development-only instrumentation.** Meter in production, next to `usage_daily`.
- **`total_changes()` as a cost gate.** It undercounts indexes by roughly 4-5x on Xin's schema.

## 14. Fit with Xin's rules

**Update, 2026-11-10.** The journal (`src/kernel/journal.ts`, [11 Failures and cost](../plan/architecture/11-failures-and-cost.md) §18) moved both numbers this section was written against. Xin now measures 16 rows written and 21 read per message in the 100-thread load, so a heavy day of 300 messages is 4,800 rows — 4.8% of a free-plan day, not the 549 messages the 182 rows/message reading implied. The 20k estimate and the 182 rows/message figure below are the pre-journal reading; what survives is the method, and the rule that the paid bill is small while `total_changes()` undercounts because it excludes index rows.

`docs/plan/architecture/11-failures-and-cost.md` reasoned, when this was written, that a heavy day was ~20k rows and ~2¢, "which is why Xin drops kiko's row-budget machinery". The free plan's ceiling is 100,000 rows **per day**, and on the pre-journal measurement of 182 rows/message that was reached in 549 messages. The *paid* bill was genuinely small even then; the *quota* was what bit, on a single-user free-plan install. The journal is what removed that concern.

Item 1 does not conflict with "official primitives first": `MemoryStorage`, `prepareCommit`, `StorageWrite` and `apply()` are pi-durable's own exported API, which is precisely what Kiko builds on. It also fits "one module per mechanism": the adapter belongs in `src/kernel/pi.ts` beside `Harness.open`, with replay and compaction as its own module.

Reads deserve their own gate. Xin's 21 reads a message is a warm-path number; measure a cold start separately, because replay is paid once per instance and must not be allowed to grow with history the way Kiko's does.

## 15. Reproducing this

Two instruments, both kept next to this document.

- **Kiko's side**: `docs/study/kiko-meter.integration.test.ts` is the probe that produced 6 writes / 4,094 reads at 22 messages / 331,316 at 324. Copy it to `kiko/apps/server/integration/` and run `bunx vitest run --project worker integration/kiko-meter.integration.test.ts --silent=false` from `kiko/apps/server`; it drives the real Worker through Kiko's own `localWorker` harness and reads `GET /api/dev/stats`.
- **Xin's side**: `test/rows.ts` is the same meter for `Home`: it patches `sql.exec`, the KV methods and the alarm methods and reports the cursors' own `rowsRead` / `rowsWritten`, so index rows are counted the way Cloudflare counts them. `test/rows.test.ts` runs one message and one reply through the faux provider and holds a SQL baseline of **5 written / 10 read** per message in an empty home, with a tolerance of 5 (the meter also reports the KV and alarm rows it adds to that); it prints the measured numbers when the billed SQL rows move past the tolerance, and updating `BASELINE` is how a new number is accepted. Since the journal, that baseline counts journal rows and their truncation, not a table per record.

Use `test/rows.ts` for the before and after numbers. `src/cost.test.ts` and `test/load.bench.ts` now bound the same billed counters through `test/meter.ts`, so their bounds are billing numbers, unlike the `total_changes()` bounds they replaced: an insert into a table with two indexes reports one change and is billed as three.
