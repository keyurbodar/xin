# 1 · The Home DO host loop

This section decides the shape of the Home DO host loop: one SQLite-backed Durable Object per owner, with the alarm armed before any call that can start work.

Read with: [02 State](./02-state.md) for what the host stores, [10 Time](./10-time.md) for how every timer folds into `arm()`, [11 Failures and cost](./11-failures-and-cost.md) for the failure matrix.

There is one SQLite-backed Durable Object per owner. Its shape is copied from pi-durable's own `test-workers/worker.ts`, which is the official way to host a Harness on Cloudflare. The rule that governs everything: **arm the alarm before any call that can start work**. An early alarm is harmless. A missing alarm strands work forever.

```mermaid
sequenceDiagram
  autonumber
  participant E as Event
  participant H as Home DO host
  participant P as pi Harness
  participant D as DO SQLite
  participant T as Clock timers

  Note over H: constructor runs inside blockConcurrencyWhile
  E->>H: constructor
  H->>D: setAlarm now plus 60 s fallback
  H->>H: root Context, provide host facts, XinLoader
  H->>H: mount composed rows; db row migrates host steps
  H->>P: pi row init: Harness.open with prefix pi_ and onWake to clock.arm, provides harness
  H->>H: rows that inject harness start; loader.await, all rows settled
  H->>P: harness.wake
  H->>H: arm wake
  H->>P: harness.resume

  E->>H: fetch or webSocketMessage
  H->>H: decode command
  H->>H: arm with active true FIRST
  H->>H: ops.run cmd then ack

  E->>H: alarm
  H->>H: fired, then arm with wake and active true
  H->>P: harness.resume
  H->>T: clock.fire now

  E->>H: onWake
  H->>H: arm again

  Note over H: idle owner has no live tasks and no debounce
  Note over H: so no periodic wake is armed, only far module dues (weekly sweep, daily Dreamer), it hibernates, cost 0
  Note over P: harness.closed on a storage error ends the Harness
  Note over P: ctx.abort, the next event reconstructs, commits stay atomic
```

The constructor steps, in order:

```text
constructor:
  blockConcurrencyWhile(
    1 setAlarm(now+60s) fallback
    2 root Context; provide host facts; XinLoader (09 Plugins)
    3 mount rows: db (migrate host steps), clock, pi (opens the Harness, provides harness), ops, http,
      wire (rehydrates sockets once harness exists), secrets, plugins, packages, system; the base bundle also
      carries tool-plugins, off by default
    4 loader.await(); a failed required row stops here as boot_failed; a failed feature row fails alone
    5 clock.arm(harness.wake())
    6 harness.resume() )
```

A step that throws is caught like a failed required row: the home keeps its storage and answers `503 {error:"boot_failed"}` on every route except `POST /v1/repair`, which can drop the journal or the checkpoint and boot again (11).

The event handlers:

```text
webSocketMessage / fetch:
  decode command
  arm({active:true}) FIRST
  ops.run(cmd) → ack

alarm():
  fired()                          // the runtime cleared the alarm it ran
  arm({...wake(), active:true})
  harness.resume()
  clock.fire(now)                  // every timer's fire, each isolated: one that throws is logged, the rest still fire
  arm(harness.wake())              // in a finally: the closing arm runs even if the body threw
```

`arm()` folds every deadline into one alarm, and writes it only when it has to move:

```text
arm(wake):
  pi  = wake.at
  due = min(pi, ...timer.due())          // the next deadline, if any; a timer whose due() throws is logged and skipped
  due = none ? (wake.active ? keep : deleteAlarm())
             : (armed == due ? keep : setAlarm(due))
  failed write → ctx.abort(), and the caller's arm() rejects  // restart, re-arm
```

Three rules keep the write count down without delaying work:

- **Arms coalesce.** A call that arrives while one is running joins the next round, and the round uses the latest wake, so a burst of wake changes costs one round of `due()` reads, not one per call.
- **One deadline, one row.** The alarm is written only when the earliest deadline moves, and deleted when an idle home has none. There is no fixed heartbeat: a run in progress holds the alarm it already has and, when it has none, arms one recovery alarm 60 s out, because pi's `active` contract says a process that dies while work is running must be woken again. An eviction during a run is recovered by the turn's own retry. `fired()`, called first in `alarm()`, marks the consumed alarm unset so the next arm writes one.

`onWake` fires whenever pi's next-needed time changes (a sleep is created, work starts or ends), and it calls `arm()` again. A run in progress keeps the alarm it has; when it has none, `arm()` writes a recovery one 60 s out, so a deploy or crash mid-reply is woken even if the client stays quiet. Nothing rearms it every 60 s while it stands, and `resume()` continues from the last checkpoint. The only non-pi timer is the debounce (`xin.intake`'s `fireAt`), folded into the same `min()`. Both 60 s alarms are one-shot, not a heartbeat: the boot fallback the constructor writes when no nearer alarm exists, so a home evicted while idle still wakes once, and this recovery arm for a run that is still going.

An idle owner has no live tasks and no debounce, so once its boot fallback has fired and `arm()` finds no deadline, the alarm is deleted. The alarm then sits at the earliest far module `due()` (the weekly file sweep, the daily Dreamer pass, the next schedule slot), or is deleted when there is none. It hibernates, its sockets stay open, and it costs $0. If a storage error ends the Harness, `harness.closed(failed)` runs: `ctx.abort()`, the next event reconstructs the instance, and commits stay atomic.

The host is about 120 lines. Feature code lives in plugins, and the host never branches on a feature.

## Runtime facts and their consequences

| Runtime fact | Consequence for the design |
| --- | --- |
| A DO is single-threaded, and storage calls inside one turn of the event loop are atomic | The intake claim cannot race. It is one commit on the `xin.intake` document that marks every due item `claimed` with its batch id, and a crash before the submission is replayed from that document (§5), so the claim needs no `UPDATE … RETURNING`. |
| Eviction or deploy during an LLM stream | pi counts it as a failed attempt and retries. The UI sees the partial text reset. The prompt cache makes the retry cheap. |
| CPU limit per event (default 30 s) | Set `limits.cpu_ms` to 300000 in wrangler. Streaming JSON parse is light, but compaction plus big tool outputs can spike. The Workers Free plan rejects that key, so `wrangler.free.jsonc` is the same config without it and a free-plan deploy uses `wrangler deploy -c wrangler.free.jsonc --assets ./web/dist`. |
| Subrequest cap per invocation | **Risk to verify in M0.** Long multi-thread work runs inside whichever event woke the DO. Kiko hit this. The test: 10 threads × 30 tool calls on one wake. If it trips, the fix is to slice work across alarm invocations (pi's retry handles the split). |
