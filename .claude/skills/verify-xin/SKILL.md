---
name: verify-xin
description: Drive the real Xin backend (Cloudflare Worker + Home Durable Object) under `wrangler dev` over HTTP/WebSocket and capture evidence. Use to prove a Xin feature works against the running Worker, not just in vitest, and at the end of every milestone.
---

# Verify Xin

Xin is a backend only. The user surface is the HTTP and WebSocket API a web client calls with the owner's bearer token. Proof means a real request to a real `wrangler dev` Worker, with the response and the resulting state captured.

Two harnesses, used together:

1. **`xin.sh` against `wrangler dev`**: the user path. Every feature in `features/` is driven this way at least once.
2. **The gate** (`bun scripts/gate.ts submit test --only=<path>`): vitest-pool-workers for what HTTP cannot reach on demand (evictions, `runDurableObjectAlarm`, faux models). Never run vitest directly.

## Launch

```bash
.claude/skills/verify-xin/xin.sh launch     # prints "ready http://127.0.0.1:8799 pid N"
```

It starts `bunx wrangler dev` on `XIN_PORT` (default 8799) with state in `.verify/state`, a throwaway `OWNER_TOKEN` (`verify-owner-token`) and a throwaway `KEK`, passed with `--var`. It never reads `.dev.vars` secrets for the token. It is ready when `GET /health` returns `ok`, and it refuses to start if that port already answers. To run two instances, set a different `XIN_PORT` and `XIN_RUN` for each.

## Doctor

```bash
.claude/skills/verify-xin/xin.sh doctor      # "doctor: ok pid N http://127.0.0.1:8799"
```

Read-only. It checks that the pid is the one this run started, `/health` answers `ok`, and the token gets a 200 on `/v1/status`. Run it first whenever anything looks wrong. If it fails, read `.verify/wrangler.log`.

## Drive

```bash
.claude/skills/verify-xin/xin.sh call GET /v1/status          # body, then "HTTP 200"
curl -s http://127.0.0.1:8799/health                          # unauthenticated route
```

`call METHOD PATH [JSON]` sends the bearer token. A WebSocket client must pass the token as the subprotocol `bearer.<token>` (browsers can't set headers). Per-feature recipes are in `features/README.md`.

## Evidence

Save each proof under `.verify/evidence/<milestone>-<feature>.txt`: the exact command, the full response, and any state read back afterwards (a second call that shows the side effect). Proof standards:

- Use the real route and the real token check, never a test-only endpoint or an internal setter.
- Capture the action and the resulting state, not only the final reply.
- Check side effects (stored rows via a later read, R2 objects, frames on a socket) alongside the response.
- The model transport is the only thing that may be faked, and only in the gate. Under `wrangler dev` a model call needs a configured provider (M3+). Live models are opt-in with `XIN_LIVE=1`.

## Cleanup

```bash
.claude/skills/verify-xin/xin.sh stop        # kills only the process group it started, deletes .verify/state
```

`.verify/evidence/` survives cleanup. Never `pkill wrangler` or `pkill workerd`: other worktrees and the gate runner may own those processes.

## Helpers

- `xin.sh`: launch, doctor, call, stop (shown above). The env overrides are `XIN_PORT`, `XIN_RUN` and `XIN_TOKEN`.
