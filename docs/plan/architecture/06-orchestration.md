# 8–12 · Orchestration

This section decides the coordinator's tool surface, a thread's life as pi objects, how slow tools become jobs, how a question ends a turn, and how the watchdog makes every failure visible.

Read with: [02 State](./02-state.md) for `xin.thread` and `xin.requests`, [04 Intake and dispatch](./04-intake-and-dispatch.md) for the batch a report or question enters, [05 Models](./05-models.md) for `set_model` and per-thread models, [07 Memory](./07-memory.md) for what a thread can recall, [10 Time](./10-time.md) for schedules, [11 Failures and cost](./11-failures-and-cost.md) for the failure matrix.

## 8 · Orchestrator tools (t3 contract, ported onto pi)

The coordinator gets this tool surface. Threads get a narrower version (no `delegate_task` by default, so there are no grandchildren unless the project allows them).

| Tool | Input | Implementation on pi |
| --- | --- | --- |
| `capabilities` | - | current model, short model list, thread limits, plugin row states |
| `delegate_task` | `{task, title, role?, target?:{model}, mode:"async"\|"wait", timeoutMs≤8000, clientRequestId}` | one commit: background Anchor task + task-owned child conv + `xin.thread` doc + workspace threadIds. Then submit the brief with requestId `delegate:…`. In `wait` mode, wait on the child's submission with a deadline |
| `task_status` | `{threadId}` | reads `xin.thread` + last assistant text |
| `task_cancel` | `{threadId?, jobId?, reason?}` (exactly one id) | `conversation.abort({background:true})` on the child, status → cancelled; a `jobId` aborts that job task |
| `thread_send` | `{threadId, text, mode:"steer"\|"queue"}` | child `submit` with that `whenBusy`. On a resolved thread it starts a new run in the same conversation |
| `thread_read` | `{threadId, after?}` | entries after a cursor, text only, bounded at 4k tokens |
| `thread_list` | `{projectId?, status?}` | projection of the workspace and thread docs |
| `pending_request` | `{action:"list"\|"read"\|"respond", threadId?, requestId?, answer?}` | §11 |
| `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit` | dsh `tool-schedule` | §16, [§19](./13-always-on.md) |
| `get_goal` / `create_goal` / `update_goal` | dsh `tool-goal` | [`goal.set`](13-always-on.md), controlled by the `goal-rounds` row |
| `set_model` | §7 | |

> **A child receives only its brief and role, never the parent's history.** This is the t3 rule. Briefs have to be self-contained, threads start cheap and focused, and nothing private leaks into a thread by accident. A thread pulls what it needs with `read`, `recall` and `thread_read`.

**Policy ceiling** (t3): a child's tools are a subset of its parent's. Its file scope is equal to or narrower than the parent's (default `project`). Its plugin set is the project's selection. `delegate_task` refuses anything broader with `capability_denied`.

## 9 · A thread's life in pi terms

```mermaid
flowchart LR
  D["delegate_task, one commit<br/>tx.createTask Anchor with background<br/>tx.createConversation owner = anchor<br/>configure child model and tools subset of parent<br/>doc xin.thread status working"] --> C["child conversation<br/>submit brief with requestId<br/>pi.generation and pi.tool xN<br/>hook afterResponse sets beatAt<br/>tool status sets statusLine"]
  C --> S["settles<br/>done to completed<br/>ask_user to waiting<br/>unanswered to failed<br/>abort to cancelled"]
  S --> G["Reporter task, background, per run<br/>inbound kind=report<br/>command_id report:thread:runOrdinal"]
  G -.-> I["intake then coordinator turn<br/>batched with other reports"]
```

Thread status transitions:

```mermaid
stateDiagram-v2
  [*] --> working
  working --> completed: done
  working --> waiting: ask_user
  working --> failed: unanswered
  working --> cancelled: abort
  waiting --> working: answer submitted, new run
  completed --> working: thread_send reopens, run N+1
  failed --> working: thread_send reopens, run N+1
  cancelled --> working: thread_send reopens, run N+1
```

- **Why an Anchor task**: a child owned by a background task is outside the coordinator's abort and idle boundary. If you stop the coordinator, threads keep going. To stop everything, use `abort({background:true})`. This is pi example 22.
- **Result text** is the last assistant message of the final run, read from the thread conversation itself. A failed run shows its provider error before any progress text (t3).
- **Re-opening** a resolved thread with `thread_send` starts run N+1 in the same conversation, sets status back to `working`, bumps `xin.thread.run`, and creates a new Reporter with key `report:th:N+1`. The Reporter's brief and both direct submits use one request key, `thread-send:th:sendKey`, so a replay after a crash places the input once.
- **`thread.stop` only aborts** the thread's run, in the background. The Reporter is the single writer of a terminal status; the stop op never writes `cancelled` itself, so it cannot race the Reporter.
- **`thread_read`** advances its cursor only past entries it returned. When one entry alone exceeds the bound, it returns a trimmed excerpt of that entry and advances past it, so the next read does not skip it.
- **Scoping**: every thread tool and both thread ops resolve the caller's project first — the caller's project when it is that project's coordinator, or the project named by the caller's own `xin.thread` — and accept a thread only when it is listed in that project. A thread with another project's id reads as absent.
- **Limits** (from owner settings, never hidden): live threads per project and per owner. Over the limit, `delegate_task` returns `limit_reached` with the list of live threads, and the coordinator tells you.

You steering a thread directly in the UI = `op thread.send(steer)`. Same path the coordinator's `thread_send` uses.

## 10 · Jobs: one code path, two latencies

Any tool declared `latency:"maybe-slow"` (web research, a large fetch, an MCP call) is wrapped once with `wrapTool`:

```text
execute(args, api, ctx):
  job = api.createTask(Job, {tool, args}, {background:true})     // the real call runs in the Job's phase
  doc xin.jobs[job] = {tool, startedAt, deadlineAt, parentId}
  doc xin.jobs.calls[api.taskId] = job                            // replay reuses this job, never a second one
  r   = await waitForTask(job, deadline 8000)                     // cancelling the wait never cancels the work
  if r.done   → doc delete xin.jobs[job]; return r.result        // felt synchronous
  else        → doc xin.jobs[job].detached = true; return "started (job j_42), result will follow"
Job.finish  → doc result; the JobsDoc observer enqueues inbound kind=job, command_id="job:"+id
```

The wrapper is always `replay:"safe"`. A replay of the same tool task finds its call id in `xin.jobs.calls` and waits on the job it already made. A job created inside a thread (the caller has a `xin.thread` doc) is never detached and never reports: the wrapper waits inline until the job settles or the thread's deadline passes.

A pi task cannot call a tool, so the wrapper supplies the tool's work as a runner registered under the tool's name; the Job phase runs it with the task's signal, clock, models and environment. On timeout the wrapper marks the job detached, and only a detached job posts a report: a tool that answered inline never lands twice.

A job is a thread with no conversation: it shows in the Overview, the watchdog covers it, and `task_cancel` works on it. The coordinator never has to decide up front whether something is slow.

## 11 · Questions: a question ends the turn, the answer starts the next

```mermaid
flowchart LR
  A["thread calls ask_user with q and options"] --> B["commit xin.requests.open[r]<br/>status waiting<br/>terminate"]
  B --> C["Waiting on you<br/>Overview plus push if no tab<br/>inbound kind=question"]
  C --> D["answer in UI on the card<br/>op request.respond"]
  C --> E["answer in coordinator chat<br/>pending_request respond"]
  D --> F["thread resumes<br/>submit answer, new run<br/>open[r] becomes answered[r]"]
  E --> F
```

- `respond` also DELETEs the question's inbound row if still pending, so the coordinator never gets a turn about an answered question.
- Why not a tool that waits for the answer: a held tool task across hours of eviction needs replay tricks; a finished run needs nothing.
- `respond` returns `{kind:"answered", run}` or, on a replay after the first answer, `{kind:"already_answered", answer}`. An unknown request, a thread that is not waiting, or a thread with no parent is `bad_args`, checked before the request document changes.

## 12 · Watchdog: failures are always visible

```text
Watchdog = one pi background task (key "xin.watchdog"), phases: check → fail → sleep → check
 sleep:  runtime.sleepUntil(now+30s)  — exists only while a working thread or a job without a result is live; otherwise it finishes
 check, per working thread:
   stalled  = now − beatAt > 120s AND no running tool is a job wrapper (pi has no expectedMaxMs)
   overtime = now > deadlineAt                       (project setting, default 30 min)
   → commit status="failed" and result together with checkpoint {phase:"fail", victims}
 check, per job without a result: overtime = now > deadlineAt only (jobs do not beat)
 fail: enqueue report:<thread>:<run> / job:<id> (dedup by command id), abort each conversation or job task, then sleep or finish
 beatAt is written by hook(GenerationTask.afterResponse) and hook(ToolTask.afterTool): ~1 row per step
```

A waiting thread is not work: it holds no run and needs no watchdog. `request.respond` starts the next watchdog when it reopens the thread, as `thread.send` does.

A coordinator run that fails (provider error, compaction failure) commits one `xin.error` entry into the chat, which the UI renders as an error bubble with a retry button (`op message.retry` resubmits that batch). Nothing fails silently.
