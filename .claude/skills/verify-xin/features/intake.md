# Intake and dispatch

`message.send` lands a row in `inbound`. Rows for one conversation debounce (fire 2 s after the last, at most 8 s after the first; typing holds them) and are claimed in one `UPDATE ... RETURNING` as one batch, submitted as one pi input with `requestId "batch:<id>"`. The host picks start, steer, restart or stop from pi's live state (`plugins/intake/dispatch.ts`).

## Sub-features

- `message.send {conv?, text, clientTs?}`: a repeated command id inserts once.
- `message.withdraw {commandId}`: removes a still-pending row.
- `conv.stop {conv?}`: aborts the running turn.
- Socket `{t:"typing", conv, on:true}`: holds the batch, never past first+8 s.
- Crash safety: on open, due pending rows fire and claimed rows resubmit with the same requestId.

## How to get to it (user POV)

Typing three quick messages gets one reply. "stop" while it answers stops it.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"vm-1","op":"message.send","args":{"text":"hello","clientTs":1}}'   # accepted:true
$S call POST /v1/cmd '{"id":"vm-1","op":"message.send","args":{"text":"hello","clientTs":1}}'   # same ack (receipt)
$S call POST /v1/cmd '{"id":"vm-2","op":"message.send","args":{"text":"again"}}'
$S call POST /v1/cmd '{"id":"vm-3","op":"message.withdraw","args":{"commandId":"vm-2"}}'      # withdrawn:true
```

A reply needs a model (M3 credentials). 3 messages → 1 turn, restart vs steer, stop and crash re-fire are proven in `plugins/intake/gateway.test.ts` with the faux model.

## Gotchas

- Without a configured model the batch is submitted and nothing answers. The "pick a model" error bubble is M3/M5 work.

Evidence from the last wrangler dev drive: `.verify/evidence/M2-M8skills.txt`.
