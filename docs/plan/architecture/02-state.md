# 2 · State: what lives where

This section decides which state is a pi document, which is a host table, and how every idempotency key is derived.

Read with: [01 Host](./01-host.md) for the storage adapter and operation queue, [03 Commands and wire](./03-commands-and-wire.md) for the writes each op makes, [07 Memory](./07-memory.md) for the FTS tables, [08 Files](./08-files.md) for the file index.

> **Rule:** anything that must change atomically with a transcript is a pi document. Anything outside pi's commit (the claim before submit, FTS, file index, secrets) is a host table, written through the **same** `DurableObjectSqliteDatabase`, so host and pi calls share one operation queue and never interleave inside a pi transaction.

| Name | Kind | Shape | Why here |
| --- | --- | --- | --- |
| `pi_*` | pi tables | conversations, entries, tasks, docs | owned by pi-durable, never touched directly |
| `xin.workspace` | pi doc, scope session | `{projects: {id: {slug,name,goal,coordinatorId,threadIds[],settings}}}` | project + thread creation commit together with the child conversation |
| `xin.thread` | pi doc, scope conversation | `{projectId,parentId,anchorTaskId,title,role,status,run,statusLine,beatAt,deadlineAt,result?,clientRequestId}` | status flips in the same commit as the entry that caused it; `run` is the current report ordinal |
| `xin.requests` | pi doc, scope conversation (thread) | `{open: {id:{kind,question,options?,at}}, answered: {...}}` | question and the turn that asked it are one commit |
| `xin.jobs` | pi doc, scope session | `{jobs: {id: {tool,title,startedAt,deadlineAt,parentId,detached?,result?}}, calls: {toolTaskId: jobId}}` | a job is a pi task with no conversation; the doc is what the Overview and the watchdog read, and `calls` makes a replayed wrapper reuse its job |
| `inbound` | host | `id, target, kind(user\|report\|question\|job), command_id UNIQUE, body JSON, client_ts, first_at, fire_at, status, batch_id` | must be claimed *before* pi sees it |
| `receipts` | host | `command_id PK, result JSON, at` (pruned at 24 h) | duplicate commands return the first result (t3 receipts) |
| `notes` + `notes_fts` | host, FTS5 | `id, scope, text, source, origin_task, at, retired_by` · UNIQUE(origin_task, text) | FTS needs SQL, and the unique key makes `remember` replay-safe |
| `kv` | host | `profile_md`, `dreamer_cursor`, `owner_settings`, `plugins.patch` (owner patch, 09), `plugins.packages` (pending installs, 09) | small singletons |
| `files` | host | `path PK, r2_key, size, type, sha256, project, updated_at` | bytes are in R2 |
| `credentials` | host, sealed | `provider PK, sealed JSON` | backs pi-ai's `CredentialStore` |
| `plugins` | host | `id PK, sealed JSON` (other columns unused since P1) | sealed per-plugin secrets; activation and config live in `kv` `plugins.patch` (09) |
| `push_subs` | host | `endpoint PK, keys JSON` | Web Push when no tab is open |

## IDs and idempotency keys

Thread id = its pi conversation id. Each project's coordinator is an ownerless conversation, and Home's coordinator is `harness.root()`.

Every idempotency key is derived and never random:

- `requestId = "batch:"+batch_id`
- `"delegate:"+parentId+":"+clientRequestId`
- `"report:"+threadId+":"+runOrdinal`
- `"thread-send:"+threadId+":"+sendKey` — the same key for the Reporter's brief and both direct submits, so a replay delivers once
- `"error:"+conversationId+":"+taskId` — one `xin.error` entry per failed run, even after a replay
- `"sched:"+id+":"+slotIso`
- `"job:"+jobTaskId` — a job's report lands once, whether the job finished, faulted, or the watchdog stopped it
- `"question:"+requestId` — the question's inbound row; `request.respond` DELETE's it while still pending
- `"answer:"+threadId+":"+requestId` — the answered thread's next run, so a replayed respond submits once

A replay after a crash recomputes the same key and pi returns the existing submission.
