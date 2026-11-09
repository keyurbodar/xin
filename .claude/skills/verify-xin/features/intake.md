# Intake and dispatch

`message.send` lands one item in the session document `xin.intake` (`{items, nextId}`). Items for one conversation debounce (fire 2 s after the last, at most 8 s after the first; typing holds them) and are claimed in one commit as one batch, submitted as one pi input with `requestId "batch:<id>"`. The host picks start, steer, restart or stop from pi's live state (`plugins/intake/dispatch.ts`).

## Sub-features

- `message.send {conv?, text, clientTs?, attachments?}`: a repeated command id answers `accepted: true` from its existing item and inserts nothing (no receipt row; the item is the receipt). Each attachment is `{path, name, type, size?}` pointing at a `PUT /files/<path>` the Worker already stored; the turn names every file in an `<attachments>` block and, when the conversation's model takes images, sends each image under 5 MB as an `image` part.
- `message.withdraw {commandId}`: removes a still-pending item.
- `conv.stop {conv?}`: aborts the running turn.
- Socket `{t:"typing", conv, on:true}`: holds the batch, never past first+8 s.
- Crash safety: on open, due pending items fire and claimed items resubmit with the same requestId; done items stay 7 days so `message.retry` can still read their body.
- `notify.prefs` / `notify.set {waiting?, finished?, failed?, spend?, schedule?}`: which push kinds are delivered (`schedule` is off by default); `announce` skips a disabled kind before it reaches `push.notify`. `spend` covers the daily and cap alerts from the models plugin.
- `notify.quiet` / `notify.quiet.set {enabled?, start?, end?}`: minutes since UTC midnight. While the window is on, a report waits until it ends; a question waits until it has been paused two hours or the window ends, whichever comes first. Held notifications live in kv `notify.held` and the clock wakes for the earliest one.
- `push.list` / `push.unsubscribe {endpoint}`: the subscribed browsers as `[{endpoint, origin}]`, and removal of one.
- `owner.read` / `owner.set {name?, instructions?}`: the owner's name and the workspace instructions, rendered as the `<owner>` system section for every conversation.
- `session.list` / `session.close {id?}`: live sockets as `[{id, since, origin}]`; close one or all, answering `{closed}`.
- `system.metrics`: `{uptimeMs, storageBytes, sockets, rows:{total,active}, pushDevices}`, all measured.
- `usage.cap` / `usage.cap.set {usd?, clear?}` and `usage.alert` / `usage.alert.set {usd}`: the monthly cap and the daily alert. While the month's spend is at or above the cap, `message.send` answers `forbidden` and the thread pauses.

## How to get to it (user POV)

Typing three quick messages gets one reply. "stop" while it answers stops it.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"vm-1","op":"message.send","args":{"text":"hello","clientTs":1}}'   # accepted:true
$S call POST /v1/cmd '{"id":"vm-1","op":"message.send","args":{"text":"hello","clientTs":1}}'   # same ack (the item dedupes)
$S call POST /v1/cmd '{"id":"vm-2","op":"message.send","args":{"text":"again"}}'
$S call POST /v1/cmd '{"id":"vm-3","op":"message.withdraw","args":{"commandId":"vm-2"}}'      # withdrawn:true
```

A reply needs a model (M3 credentials). 3 messages → 1 turn, restart vs steer, stop and crash re-fire are proven in `plugins/intake/gateway.test.ts` with the faux model.

Attachment round trip, from a shell:

```bash
printf 'scope: launch page copy\n' > /tmp/brief.txt
curl -sS -X PUT -H "authorization: Bearer verify-owner-token" -H 'content-type: text/plain' \
  --data-binary @/tmp/brief.txt http://127.0.0.1:8799/files/projects/launch/attachments/brief.txt
$S call POST /v1/cmd '{"id":"att-1","op":"message.send","args":{"text":"read the brief","attachments":[{"path":"/projects/launch/attachments/brief.txt","name":"brief.txt","type":"text/plain","size":23}]}}'
```

Proven live: the owner bubble shows the chip and the model answered with the file's first line.

## Gotchas

- A real push subscription cannot be made on this machine: unbranded Chromium has no FCM keys, so `pushManager.subscribe` answers NotAllowedError even with notifications granted. Prove encryption and VAPID in the gate; prove the live path with `push.test` against a stored endpoint. Evidence: `.verify/evidence/P14-push-limit.txt`.

- Without a configured model the batch is submitted and nothing answers. The "pick a model" error bubble is M3/M5 work.

Evidence from the last wrangler dev drive: `.verify/evidence/M2-M8skills.txt`.
