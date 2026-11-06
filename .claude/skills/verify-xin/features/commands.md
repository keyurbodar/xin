# Commands and receipts

Every mutation is an op run through one command layer (`src/ops.ts`), reached by `POST /v1/cmd` or a socket `cmd` frame. The client picks the command id. A repeated id returns the stored receipt and never runs twice, for 24 hours.

## Sub-features

- `POST /v1/cmd` with `{id, op, args?}` returns `{t:"ack", id, ok, result | error:{code, message}}`.
- Rejections: `unknown_op`, `bad_args` (schema), `forbidden` (actor above the op's ceiling), `failed` (the op threw, with no receipt, so a retry runs again).
- Malformed body: HTTP 400.

## How to get to it (user POV)

Every button in the web client sends a command, and retries after a reconnect reuse the same id.

## Driving it with xin.sh

```bash
.claude/skills/verify-xin/xin.sh call POST /v1/cmd '{"id":"v-1","op":"nope"}'   # ok:false unknown_op
.claude/skills/verify-xin/xin.sh call POST /v1/cmd '{"id":"v-1","op":"nope"}'   # same ack, from the receipt
.claude/skills/verify-xin/xin.sh call POST /v1/cmd '{bad'                        # HTTP 400
```

Ops come from plugins. Which ops exist under `wrangler dev` depends on `src/plugins/bundled.ts`. The effect-once proof (`test.bump` counter) runs through the gate: `src/ops.test.ts`.

## Gotchas

- An op's effect and its receipt are not one transaction. A crash in between reruns the op, so every op must be idempotent through its derived key (`docs/plan/architecture/02-state.md`).
