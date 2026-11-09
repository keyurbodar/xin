# 17–18 · Failures and cost

This section decides where each failure is caught and what the user sees, and records the DO row-cost model that Xin accepts at personal scale.

Read with: [01 Host](./01-host.md) for the alarm and Harness recovery paths, [03 Commands and wire](./03-commands-and-wire.md) for receipts, [04 Intake and dispatch](./04-intake-and-dispatch.md) for claim and submit recovery, [06 Orchestration](./06-orchestration.md) for the watchdog.

## 17 · Failure matrix

| Failure | Where it's caught | User sees |
| --- | --- | --- |
| Same command sent twice (reconnect) | `receipts` / `command_id UNIQUE` | one message |
| Crash between claim and submit | boot scan: claimed rows without a submission are resubmitted with the same requestId | nothing |
| Eviction mid-stream | pi failed attempt → retry, alarm heartbeat ≤ 60 s | partial text resets, then completes |
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
| One owner message → one reply (`src/cost.test.ts`) | 41 measured, bound 55 |
| One delegate → thread → report → coordinator reply (`src/cost.test.ts`) | 181 measured, bound 235 |
| One message in a 100-thread home, half with two tool calls (`test/load.bench.ts`) | 131 written, 229 read, 264 statements |
| One cold message after eviction, in that home | 70 written, 1,821 read, 1,310 statements |
| One idle alarm in that home | 2 written, 8 read, 16 statements |
| Idle hour | 0 (no alarm armed) |

Both scenario measurements come from `SELECT total_changes()` deltas around each scenario in the real `Home` DO. `total_changes()` counts rows changed, not index entries, so it undercounts what Cloudflare bills; the load below counts the billing rows. The bounds carry about 30% headroom, so a regression that adds bookkeeping rows fails the test instead of hiding in the average.

**The 100-thread load.** `test/load.bench.ts` (`XIN_LOAD=1 bun scripts/gate.ts run test`) builds one project with 100 thread conversations, sends each thread three messages (half of them two tool calls), evicts the Home between ten more messages, and fires five idle alarms. `test/meter.ts` wraps the Home's storage and counts what Cloudflare bills: SQL rows from each cursor's own `rowsRead`/`rowsWritten` (its documented billing counters), each key-value method as one row, and each alarm method as one row. The numbers are cumulative totals per phase, and the benchmark asserts the per-message bounds above.

**Where the 131 rows go.** About 113 are pi's commit bookkeeping and about 18 are Xin's. pi's biggest line is the task table: every task state change rewrites the task's row plus the indexes a query reads, and a two-tool message changes task state about sixteen times (a generation task per model round, a task per tool). Six of pi's indexes are read by no query in 1.5 — tasks by conversation, abort flag and background flag, submissions by conversation, documents by scope kind, conversations by owner conversation — so Xin drops them after `Harness.open` (`src/kernel/pi.ts`); that took the load from 182 to 131 rows a message and left reads unchanged. The rest is per commit: the live and usage documents are rewritten as bases (26 rows and 8 revision deletes), `pi_durable_metadata` and `pi_record_ids` take a row each (25), entries and submissions take 15, and Xin adds the intake row and its status updates (9), the command receipt (3), the alarm (4) and the batch ledger (2).

**What a message genuinely has to keep.** The user's entry, the answer, the tool results, a marker that a run is in flight, and the alarm: five or six rows. pi writes about twenty times that because it checkpoints every task phase and every document as its own row with its own indexes. The ladder from 131 to a handful, with what each step trades:

| Step | Rows a message | Trade |
| --- | --- | --- |
| Today, with the unread indexes dropped | 131 | none |
| Record ids in memory, a leased id counter instead of a metadata row per commit | ~106 | needs a patch to pi's `SqliteStorage`; ids skip a block after a crash |
| No task checkpoint per model round | ~82 | a crash mid-round re-runs that round, tool calls included |
| Live document deltas instead of a base per commit | ~67 | more rows read at each commit, a longer delta chain |
| pi's state in a journal, one row per turn (kiko's `core/agent/src/journal.ts`) | ~6 to 15 | the state lives in memory, a cold start replays the journal, an eviction re-runs what the last flush missed, and the journal needs compaction; Xin's intake and receipts would fold in too |

The first four keep pi's durability model and its tables; the last replaces them. The spec's "no custom journal or storage proxy" rule is what keeps the first four in bounds, so the last is the owner's call.

A heavy day (300 messages, 40 threads) writes about 39k rows, roughly 4¢ on the paid plan and 40% of a free-plan day. That is why Xin drops kiko's row-budget machinery: a budget mechanism would police a number the agent's own commits set, and at personal scale the meter that still matters most is LLM tokens. The levers are batching (§5), brief-only children (§8), stable sections first (persona → profile → project instructions → skills index), live state as entries and never as changing sections, and the per-message overhead counted above. `src/cost.test.ts` holds the upper bounds so a regression shows up, and `test/load.bench.ts` holds the 100-thread ones.

**Token spend.** pi keeps `pi.usage` in every conversation: token counts and catalog or provider-reported cost per `provider/model`, plus tool-reported usage per tool, including failed and aborted attempts. `harness.usage()` sums them for the whole Session and `usage.summary` exposes that sum to the Usage pane and the Home spend cell. The ledger has no time dimension, so `models.recordUsage()` turns it into one: it reads the live totals, subtracts the totals it last stored (`kv: usage.total`), and adds the difference to `usage_daily` under today's UTC date (migration 4). Each call adds only what the stored total does not already cover, so a replayed or repeated call adds nothing. `usage.summary` flushes first and then answers `spend`/`tokens` (all time) beside `today` and `month` (rows since UTC midnight and since the first of the month). A flush runs at most once a minute, and `usage.summary` flushes on demand, so a day's row is written within a minute of the run that spent it. The timer that flushes only does so when the last flush is a minute old: a full pass reads every conversation's `pi.usage`, and an alarm that wakes for a heartbeat has usually spent nothing. A home that has no watermark yet is seeded at boot with its current totals and books nothing: the counter starts from the first spend it can see, and a ledger that predates this build is never blamed on today. A run that crosses midnight counts in the day it finishes.

**Cap and alerts.** The owner stores a monthly cap (`kv: usage.cap`) and a daily alert (`kv: usage.alert`, default $8) through `usage.cap.set` and `usage.alert.set`. Each flush compares the dated totals with both: a day past the daily alert records `kv: usage.alerted.day` once for that day, and a month past 80% of the cap and past the cap itself records `kv: usage.alerted` once per level. Each new mark pushes one `spend` notification, which the owner can switch off with `notify.set`. The cap is enforced at the door: `message.send` answers `forbidden` while the month's spend is at or above it, so a thread pauses and the owner raises the cap in Usage. Because the ledger moves at most once a minute, the check can lag the newest spend by that minute. A home with no cap set never blocks.

**Per project.** `usage.summary` also returns `byProject`, summed from the `pi.usage` document of each project's coordinator and threads. The root chat belongs to no project, so its spend appears in the totals and in no project row. The ledger itself has no project dimension; this is a sum over the conversations the workspace document names.
