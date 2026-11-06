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
| Plugin throws | a throwing tool gives an error result, a throwing hook is reported and skipped, a failed reconcile marks only that plugin | the plugin shows as failed in settings |
| Deploy changes a plugin's tool | running calls finish on the old code and the next phase uses the new (pi reload rule) | nothing |

## 18 · Cost model (DO SQLite rows written, about $1 per million)

| Event | Rows written (approx.) |
| --- | --- |
| Burst intake (3 messages) | 3 inbound + 1 claim update + 1 receipt per command |
| Coordinator reply, no tools | user entry + assistant entry + live/inbox docs + partial commits (one per `partialIntervalMs`=200 ms of streaming) |
| Thread, 20 tool steps | ~3 per step + beats ≈ 80–120 |
| One owner message → one reply (`src/cost.test.ts`) | 38 measured, bound 60 |
| One delegate → thread → report → coordinator reply (`src/cost.test.ts`) | 163 measured, bound 250 |
| Idle hour | 0 (no alarm armed) |

Both scenario measurements come from `SELECT total_changes()` deltas around each scenario in the real `Home` DO. The bounds carry about 50% headroom, so a regression that adds bookkeeping rows fails the test instead of hiding in the average.

A heavy day (300 messages, 40 threads) writes about 20k rows, roughly 2¢. That's why Xin drops kiko's row-budget machinery: at personal scale the meter that matters is LLM tokens. The levers there are batching (§5), brief-only children (§8), stable sections first (persona → profile → project instructions → skills index), and live state as entries, never as changing sections. `src/cost.test.ts` holds the upper bounds above so a regression shows up.
