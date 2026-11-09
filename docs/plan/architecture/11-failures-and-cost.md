# 17–18 · Failures and cost

This section decides where each failure is caught and what the user sees, and records the DO row-cost model that Xin accepts at personal scale.

Read with: [01 Host](./01-host.md) for the alarm and Harness recovery paths, [03 Commands and wire](./03-commands-and-wire.md) for receipts, [04 Intake and dispatch](./04-intake-and-dispatch.md) for claim and submit recovery, [06 Orchestration](./06-orchestration.md) for the watchdog.

## 17 · Failure matrix

| Failure | Where it's caught | User sees |
| --- | --- | --- |
| Same command sent twice (reconnect) | `receipts` / `command_id UNIQUE` | one message |
| Crash between claim and submit | boot scan: claimed rows without a submission are resubmitted with the same requestId | nothing |
| Eviction mid-stream | pi failed attempt → retry, resumed by the run's own next step | partial text resets, then completes |
| Eviction mid-tool | `replay:"safe"` tools re-run, others get an `interrupted` result, and the model adapts | the tool shows as interrupted, then retried |
| Hung tool or provider | watchdog, 2 min | "stopped: no progress…" report |
| Provider down | pi retry → run unanswered → report or error bubble | error names the provider and offers a model switch |
| Storage error | `harness.closed` → `ctx.abort()` → fresh instance | socket reconnects, snapshot |
| Alarm write fails | `ctx.abort()`, so the constructor's fallback alarm re-arms | nothing |
| Plugin throws | a throwing tool gives an error result, a throwing hook is reported and skipped, a row that fails to start is marked `failed` with its error and its effects unwound; other rows keep running, and a failed required row puts Home in `boot_failed` | the plugin shows as failed in settings |
| Deploy changes a plugin's tool | running calls finish on the old code and the next phase uses the new (pi reload rule) | nothing |

## 18 · Cost model (DO SQLite rows written, about $1 per million)

| Event | Rows written (approx.; reads and statements where noted) |
| --- | --- |
| Burst intake (3 messages) | 3 inbound + 1 claim update + 1 receipt per command |
| Coordinator reply, no tools | user entry + assistant entry + live/inbox docs + partial commits (one per `partialIntervalMs`=200 ms of streaming) |
| Thread, 20 tool steps | ~3 per step + beats ≈ 80–120 |
| One owner message → one reply (`src/cost.test.ts`) | 25 written (bound 36), 39 read (bound 64) |
| One delegate → thread → report → coordinator reply (`src/cost.test.ts`) | 52 written (bound 64), 81 read (bound 104) |
| One message in a 100-thread home, half with two tool calls (`test/load.bench.ts`) | 26 written, 36 read, 56 statements |
| One cold message after eviction, in that home | 24 written, 310 read, 105 statements |
| One idle alarm in that home | 2 written, 7 read, 15 statements |
| Idle hour | 0 (no alarm armed) |

Both scenario measurements come from `SELECT total_changes()` deltas around each scenario in the real `Home` DO. `total_changes()` counts rows changed, not index entries, so it undercounts what Cloudflare bills; the load below counts the billing rows. The bounds carry about 30% headroom, so a regression that adds bookkeeping rows fails the test instead of hiding in the average.

**The 100-thread load.** `test/load.bench.ts` (`XIN_LOAD=1 bun scripts/gate.ts run test`) builds one project with 100 thread conversations, sends each thread three messages (half of them two tool calls), fills the journal towards a full checkpoint and evicts once, then fires five idle alarms. `test/meter.ts` wraps the Home's storage and counts what Cloudflare bills: SQL rows from each cursor's own `rowsRead`/`rowsWritten` (its documented billing counters), each key-value method as one row, and each alarm method as one row. The benchmark reports the synthetic fire-at write separately from the message, the alarm window as harness rows, and the cold boot replay apart from the turn that follows it; it bounds all of them, so a harness or replay regression cannot hide inside a total.

**pi's state is a journal, not a table per record.** The harness runs on pi's `MemoryStorage`, so its reads are map lookups and a commit reaches disk as one journal row holding that commit's `StorageWrite`s (`src/kernel/journal.ts`). A flush happens at the commit that settles a submission — the end of a turn — so a two-tool message that runs three model rounds and several tool tasks is still one row. Two other things flush: a commit that changes any document other than `pi.live` (configuration: a model, a thread, a schedule, a project), and a turn that reaches `FLUSH_BYTES` (1 MB) of pending writes. A `pi.live` progress commit is the streamed answer and waits for the turn's boundary, so a long reply does not write one row per second.

A journal alone replays forever, so every `CHECKPOINT_ROWS` (256) journal rows the storage writes the whole state as one commit of `StorageWrite`s — conversations, tasks, submissions, documents, entries — stores it in `pi_checkpoint`, and deletes the journal rows it covers. The rewrite is one transaction, so a crash cannot leave neither the old checkpoint nor the new one, and a replay only reads journal rows newer than the checkpoint's sequence, so a crash before the journal delete does not repeat a commit. A cold start reads that checkpoint and at most 256 journal rows: the 100-thread load's cold message reads about 310 rows, of which ~280 are replaying a near-full journal and 1–3 are the checkpoint's parts. Truncation costs one row per row deleted, so the journal's total is about 5.8 rows a message: the row it writes, its part rows, and the checkpoint rewrite and truncation it amortizes.

**What that costs in durability.** Writes are durable at a flush, not at a commit. An eviction during a turn loses that turn's unflushed commits; the harness retries the attempt it was in and the client's retry carries the same request id, so the turn runs again rather than being lost — but it can run again, tool calls included, and any tokens it spent are spent twice. Configuration and a finished turn are durable at once. The state also lives in the object's memory, so a home's whole history has to fit in the 128 MB an object gets; the checkpoint is the recovery path, not an off-heap store.

**Where the 26 rows go.** The intake row and its two status updates are 14, the command receipt 3, the alarm 4, the journal 5.8 (its rows and parts plus the checkpoint rewrite and truncation it amortizes), and a preset row 0.3. The first four are rounded per phase; the journal is the one line that grows with a checkpoint, which is why it is measured over the whole load. Everything pi writes is inside the journal row. The hottest reads are point lookups: the intake queue by target and batch, receipts by command id, kv by key, and the journal by sequence; the only scan left is the hourly receipt sweep, which is bounded by the index on its age.

A heavy day (300 messages, 40 threads) writes about 8k rows, under 1¢ on the paid plan and 8% of a free-plan day. That is why Xin drops kiko's row-budget machinery: a budget mechanism would police a number the agent's own commits set, and at personal scale the meter that still matters most is LLM tokens. The levers are batching (§5), brief-only children (§8), stable sections first (persona → profile → project instructions → skills index), live state as entries and never as changing sections, and the per-message overhead counted above. `src/cost.test.ts` holds the upper bounds so a regression shows up, and `test/load.bench.ts` holds the 100-thread ones.

**Token spend.** pi keeps `pi.usage` in every conversation: token counts and catalog or provider-reported cost per `provider/model`, plus tool-reported usage per tool, including failed and aborted attempts. `harness.usage()` sums them for the whole Session and `usage.summary` exposes that sum to the Usage pane and the Home spend cell. The ledger has no time dimension, so `models.recordUsage()` turns it into one: it reads the live totals, subtracts the totals it last stored (`kv: usage.total`), and adds the difference to `usage_daily` under today's UTC date (migration 4). Each call adds only what the stored total does not already cover, so a replayed or repeated call adds nothing. `usage.summary` flushes first and then answers `spend`/`tokens` (all time) beside `today` and `month` (rows since UTC midnight and since the first of the month). A flush runs at most once a minute, and `usage.summary` flushes on demand, so a day's row is written within a minute of the run that spent it. The timer that flushes only does so when the last flush is a minute old: a full pass reads every conversation's `pi.usage`, and an alarm that wakes for a timer has usually spent nothing. A home that has no watermark yet is seeded at boot with its current totals and books nothing: the counter starts from the first spend it can see, and a ledger that predates this build is never blamed on today. A run that crosses midnight counts in the day it finishes.

**Cap and alerts.** The owner stores a monthly cap (`kv: usage.cap`) and a daily alert (`kv: usage.alert`, default $8) through `usage.cap.set` and `usage.alert.set`. Each flush compares the dated totals with both: a day past the daily alert records `kv: usage.alerted.day` once for that day, and a month past 80% of the cap and past the cap itself records `kv: usage.alerted` once per level. Each new mark pushes one `spend` notification, which the owner can switch off with `notify.set`. The cap is enforced at the door: `message.send` answers `forbidden` while the month's spend is at or above it, so a thread pauses and the owner raises the cap in Usage. Because the ledger moves at most once a minute, the check can lag the newest spend by that minute. A home with no cap set never blocks.

**Per project.** `usage.summary` also returns `byProject`, summed from the `pi.usage` document of each project's coordinator and threads. The root chat belongs to no project, so its spend appears in the totals and in no project row. The ledger itself has no project dimension; this is a sum over the conversations the workspace document names.
