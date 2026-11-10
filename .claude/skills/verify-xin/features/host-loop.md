# Host loop status and recovery

The Home DO opens pi's Harness inside `blockConcurrencyWhile`, arms its alarm before any work, and resumes from the alarm after an eviction. `GET /v1/status` returns `{wake}` from `harness.wake()`.

## Sub-features

- Status: `{"wake":{"active":false}}` when idle. With no work there is no alarm, so the object hibernates.
- Eviction mid-turn: the alarm resumes the turn, and it is answered exactly once.
- Throughput: 10 conversations x 30 tool calls that fetch, in one invocation.
- Cost: the alarm is written only when it must move, and a 100-thread load counts what each message and wake bills (rows written, rows read, statements). The numbers live in `docs/plan/architecture/11-failures-and-cost.md`.
- Repair: a home that cannot read its journal or checkpoint answers `503 boot_failed` on every route except `/v1/repair`. `GET /v1/repair` reports `{failure, journal, checkpoint}` without changing anything; `POST /v1/repair {"drop":"journal"}` drops the rows since the last checkpoint (or `{"drop":"all"}` the checkpoint too) and opens the home again. It refuses an open home with 409.

## How to get to it (user POV)

The client reads status. Recovery is invisible to the user: a reply that was cut off arrives once, after the restart.

## Driving it with xin.sh

```bash
.claude/skills/verify-xin/xin.sh call GET /v1/status       # {"wake":{"active":false}}  HTTP 200
.claude/skills/verify-xin/xin.sh call GET /v1/repair       # {"failure":null,"journal":N,"checkpoint":N}  HTTP 200
```

Eviction and alarms can't be triggered over HTTP. Prove them through the gate:

```bash
id=$(bun scripts/gate.ts submit test --only=src/host.test.ts); bun scripts/gate.ts wait "$id"
XIN_LOAD=1 bun scripts/gate.ts run test --only=test/load.bench.ts   # 100 threads, per-message rows
```

## Gotchas

- Local workerd does not enforce production's per-invocation subrequest cap. The stress test proves correctness, not the deployed limit.
- Restarting `wrangler dev` with the same `.verify/state` keeps DO storage. `xin.sh stop` deletes it.
- The repair drop is the only route that reaches storage without the kernel, so a broken journal can still be fixed. Dropping it loses the state since the last checkpoint: `src/host.test.ts` proves the boot, the report and the reopen.

Evidence from the last wrangler dev drive: `.verify/evidence/M0-auth.txt` (`/v1/status`) and `.verify/evidence/M5-workspace.txt`.
