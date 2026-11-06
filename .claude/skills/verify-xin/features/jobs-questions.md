# Jobs, questions and the watchdog

Slow tools become jobs. A tool that finishes within 8 s returns inline. A slower one returns "started (job …)" and later lands one `job:<id>` report in the coordinator's intake. The same tool call replayed after a crash reuses its job instead of starting a second one. A job called inside a thread never detaches: the thread waits for it inline. A thread that calls `ask_user` ends its turn in `waiting`. The owner's answer starts its next run. The watchdog task `xin.watchdog` checks working threads every 30 s and fails a hung one within 2.5 min; jobs are checked only against their deadline.

## Sub-features

- `ask_user` (thread tool) and `pending_request` (`list`, `read`, `respond`).
- Owner op `request.respond` (`threadId`, `requestId`, `answer`). Returns `{kind:"answered", run}`; a second answer returns `{kind:"already_answered", answer}` with the first answer.
- `workspace.read` shows `openRequests` and the thread's `statusLine` ("waiting for your answer"). A terminal thread has no `statusLine`.
- `task_cancel` takes exactly one of `threadId` or `jobId`.
- Watchdog: no progress for 2 min (threads only), or past `deadlineAt`, gives a failure report. It exists only while a working thread or a job without a result is live.

## How to get to it (user POV)

The Overview's "Waiting on you" lists open questions. A push arrives if no tab is open. The owner answers from the coordinator chat or the Overview.

## Driving it with xin.sh

Needs a real model (see threads.md for the credential and project setup).

```bash
$S call POST /v1/cmd '{"id":"s","op":"message.send","args":{"conv":3,"text":"Call delegate_task once, mode async, title color, task: call ask_user once asking Which color should the logo be? options red and blue, then reply The logo will be <answer>."}}'
$S call POST /v1/cmd '{"id":"r","op":"workspace.read","args":{}}'          # thread in waiting, openRequests 1
$S ws '{"t":"sub","stream":"conv:<threadId>"}'                             # requestId q:<taskId>
$S call POST /v1/cmd '{"id":"a1","op":"request.respond","args":{"threadId":17,"requestId":"q:33","answer":"blue"}}'
$S call POST /v1/cmd '{"id":"a2","op":"request.respond","args":{"threadId":17,"requestId":"q:33","answer":"red"}}'   # {kind:"already_answered", answer:"blue"}
$S call POST /v1/cmd '{"id":"r2","op":"workspace.read","args":{}}'        # completed thread, no statusLine
```

Proof: the thread completes with "The logo will be blue." and `openRequests` drops to 0. Evidence: `.verify/evidence/M6-questions.txt`.

## Gotchas

- Jobs and the watchdog need minutes of time to pass, so they are proven in `src/jobs.test.ts`, `src/watchdog.test.ts` and `src/mcp.test.ts`, which backdate `beatAt`/`deadlineAt` or hold one promise instead of sleeping for minutes.
- The watchdog never fails a job for age alone; only `deadlineAt` matters. A job that finishes after 8 s and reports is the success path, not a stall.
- The coordinator also holds `pending_request` and may answer a thread's question itself before the owner does. Read `conv:<coordinatorId>` for a `pending_request` `respond` call. The owner's `request.respond` then returns `already_answered` with the coordinator's answer, which is the duplicate-answer proof. Evidence: `.verify/evidence/M6-questions-after-fix.txt`.
