# 18 · Browser: a headless browser per conversation

This section decides that an agent can drive a real headless Chromium, one per conversation, through [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0) running on an [Instabox](https://instabox.sh) machine. It is an optional plugin row that ships disabled, as the scope rule requires for browsers.

Read with: [02 State](./02-state.md) for the document and the idempotency keys, [06 Orchestration](./06-orchestration.md) for the job wrapper, [09 Plugins](./09-plugins.md) for rows, [15 Web](./15-web.md) for the plain fetch that needs no browser.

```text
tool-browser row (bundle ingle-plugin-browser, row id tool-browser, disabled)
  browser_open       { url }                  -> title, URL and the first snapshot window      (job)
  browser_snapshot   { offset? }              -> one 8,000-character window of the snapshot     (job)
  browser_act        { action, ref?, text? }  -> the action's output and the new snapshot      (job)
  browser_screenshot {}                       -> one JPEG of the viewport                       (plain tool)
  browser_close      {}                       -> deletes the machine                            (job)
```

## Tools

All five are `deferred: true`: the kernel's `tool_search` index lists each by name and first sentence, and the full definitions reach the prompt only once `tool_search` loads them.

| Tool | Runs on the machine | Notes |
| --- | --- | --- |
| `browser_open` | `agent-browser open <url>`, then `agent-browser snapshot -c` | Creates the conversation's machine first when it has none. Only `http:` and `https:` URLs; the page loads inside the VM, so the private-host policy of `web_fetch` does not apply. Returning the snapshot saves the model a round trip. |
| `browser_snapshot` | `agent-browser snapshot -c` | The compact accessibility tree with refs (`[ref=e3]`). 8,000 characters per call, paged with `offset` and the same closing line as `web_fetch`. |
| `browser_act` | `click`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `scrollintoview` with a ref; `fill`, `type`, `select` with a ref and text; `press` with a key | Then a fresh snapshot, so the next step needs no separate read. A ref may be written `e3` or `@e3`. |
| `browser_screenshot` | `agent-browser screenshot --screenshot-format jpeg --screenshot-quality 70`, then `base64 -w0` | A plain replay-safe tool, not a job: the job summary keeps text only, and two commands finish well inside the 8 s inline wait. |
| `browser_close` | none | Deletes the machine; the next `browser_open` creates a new one. |

The four job tools go through `jobs.tool`, so a first `browser_open` (create, install, open: about 10 to 20 s) becomes a job in the root chat and reports later, and waits inline in a thread. `JobRun` carries the job's `conversationId` and `jobId` (its task id), which is how a job tool finds its conversation's document and recognises its own rerun.

## Backend seam

`plugins/browser/backend.ts` is the one interface the tools and the session use:

```ts
interface BrowserBackend {
  start(session: { key }, signal): Promise<Machine>             // create; returns it ready
  run(machine, argv, signal): Promise<{ stdout, stderr, exitCode }>
  close(machine, signal): Promise<void>                         // delete: the idle close and browser_close
}
```

`Machine` is `{ id, key }`: the backend's handle and the idempotency key of the session that created it. `StartFailed` marks a create the provider refused for good, so the session drops that key. A Cloudflare Browser Rendering backend implements the same three calls (`start` opens a session, `run` drives it, `close` ends it) without a change to the tools. The owner named `start`, `run` and `stop`; since an idle machine is deleted rather than stopped (Bosun, #124), the one way down is `close`, and a stopped machine is never restarted.

**Instabox** (`plugins/browser/instabox.ts`). Base `https://api.instabox.sh`, header `X-API-Key` from the Worker secret `INSTABOX_API_KEY` (`ctx.host.env`, so the row declares `runtime`; the key is never logged or returned). Template `agent-browser` (Chromium at `/usr/bin/chromium`); size from config, 2 vCPU and 4 GiB by default. agent-browser is not preinstalled, so every `start` runs `command -v agent-browser || npm install -g agent-browser@0.43.0`: about 3 s, once per machine. Lifecycle calls send `Idempotency-Key`, wait on `GET /v1/operations/{id}?wait=25s`, and a delete sends `X-Confirm-Delete: <id>`. A `409 operation_conflict` waits for the named operation and retries once with `<key>:<operationId>`. A delete answered `404` counts as done. Commands run with `POST /v1/machines/{id}/exec { argv, timeoutSeconds }`, 60 s each.

## Session state

One session per conversation, in the conversation document `xin.browser` (`history: latest`, `fork: initial`, so a fork starts without one). It is committed with the conversation's other writes and costs no host row.

```text
{ generation, act?, session?: { generation, key, usedAt, state, machine? } }
state: starting | running (machine) | closing (machine) | closed
```

The idempotency key of a session is `ingle-browser:<pi.provider sessionId>:<generation>`, with `:create` or `:delete` appended. The provider session id is the conversation's persisted UUIDv7, so the key is derived from the conversation, unique across Homes that share one Instabox key, and fresh after a fork. `generation` counts sessions: every machine is created once and deleted once, and a reopen after a close (idle or explicit) is a new generation, so Instabox never replays an old create (it keeps keys 7 days).

- `browser_open` commits `starting` with the next key before it calls Instabox. A crash, an eviction or a transient error leaves `starting`, and the next call sends the same key, so Instabox answers with the machine it already made. Only `StartFailed` (a failed operation, which Instabox replays for the same key) drops the key: the session is removed and the next open takes a new generation.
- A successful start commits `running` with the machine and, in the same commit, creates the idle task. If the session was closed meanwhile, the open deletes the machine it just made.
- The other tools read the document without a commit, and commit `usedAt` only when it is a minute old, so idle time is exact to a minute and a burst of calls costs no extra rows.
- `browser_act` is the one call that is not safe to repeat (a click can submit a form twice), so it commits its job id as `act`, with `usedAt`, before it acts. A job that reruns after a crash finds its own id there, does not act again, and returns the page with a note that the action may already have happened. That costs one row per action.
- `browser_close` deletes the machine, then removes the session (the generation stays).
- A session found `closing` or `closed` reads as no machine: `browser_open` starts the next generation at once, while an idle delete may still be finishing for the old one.

## Idle close

`xin.browser.idle` is a background pi task owned by the conversation, one per generation. It sleeps until `usedAt + idleMinutes` (config, default 10, 1 to 1,440). On wake it rereads the document: a newer `usedAt` sleeps again, a session that moved on ends the task, and an idle one flips to `closing` in the same commit that checkpoints the `close` phase. `close` deletes the machine with the generation's delete key, so a rerun after a crash sends the same request and Instabox answers it once (a `404` counts as done); then it commits `closed`, keeping `generation`, `key` and `usedAt`. A failed delete is reported and retried in 5 minutes. A tool that finds `closing` or `closed` tells the model the browser was closed after the idle time and to call `browser_open`, which creates a new machine (about 5 s with the agent-browser install); the page has to be opened again.

## Cost

Measured with the row meter against a fake Instabox (plugins/browser/browser.test.ts drives the same paths). A plain reply turn is the baseline: 3 rows written, 9 read.

| Turn with one call | Rows written | Rows read | Instabox requests |
| --- | --- | --- | --- |
| first `browser_open` (create) | 9 | 4 | 5: create, operation, install, open, snapshot |
| later `browser_open` | 7 | 3 | 2: open, snapshot |
| `browser_snapshot` | 7 | 3 | 1 |
| `browser_act` | 8 | 3 | 2 |
| `browser_screenshot` | 4 | 3 | 2 |
| `browser_close` | 8 | 3 | 2: delete, operation |
| idle close (alarm) | 11 | 10 | 2: delete, operation |
| `browser_open` after an idle close | 9 | 4 | 5: create, operation, install, open, snapshot |

Each `usedAt` touch, at most once a minute, adds one row. A snapshot window is at most 8,000 characters (about 2,000 tokens) in every later prompt of the conversation; a screenshot is about 1,100 image tokens. Loaded, the five tool definitions are 1,987 characters, about 500 tokens.

Instabox bills a running machine by the second: at 2 vCPU and 4 GiB that is $0.008 + $0.009 = $0.017 an hour, $0.00028 a minute. A browser call holds the machine 1 to 3 s, so an action costs about $0.00001; what costs is the idle minutes before the delete: $0.00028 an idle minute, so at most 10 × $0.00028 = $0.0028 per abandoned session. After the delete nothing is billed, not even disk. The next `browser_open` pays about 5 s of running time for the create and install, about $0.00002, and the 5 requests above.

## Not added

- a Cloudflare Browser Rendering backend (the seam is above);
- a sweep of the machine of a conversation deleted before its idle close;
- downloads, uploads, tabs, cookies or a persistent profile;
- a URL allow list: the VM is outside the Home, so the browser reaches what the VM reaches.

**Live test.** plugins/browser/live.test.ts creates a real Instabox machine and runs only with an explicit opt-in: INSTABOX_LIVE=1 together with INSTABOX_API_KEY in the environment. A key alone, for example on a CI runner, leaves it skipped.
