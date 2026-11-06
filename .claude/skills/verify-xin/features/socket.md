# Wire protocol (socket)

`GET /v1/socket` upgrades to a hibernatable WebSocket. The token goes in the subprotocol list `xin, bearer.<token>`, and the server answers with `xin`.

## Sub-features

- `{t:"cmd", id, op, args?}` gives `{t:"ack", ...}`, the same as `POST /v1/cmd`.
- `{t:"sub", stream:"home"}` gives `{t:"snap", stream:"home", value:{plugins:{id:state}}}`.
- `{t:"sub", stream:"conv:<id>"}` gives a snap of the conversation view (its last 60 entries and docs), then `{t:"ev", stream, events:[ops]}` deltas.
- `{t:"unsub", stream}`, and `{t:"typing", conv, on}`, which is accepted and used by intake from M2.
- `{"_tag":"Ping"}` gets `{"_tag":"Pong"}` from the runtime without waking the object.
- Subscriptions live in the socket attachment and are rewatched when the object wakes.

## How to get to it (user POV)

One socket per open tab. A reconnect sends `sub` again and gets a fresh snapshot.

## Driving it with xin.sh

```bash
.claude/skills/verify-xin/xin.sh ws '{"_tag":"Ping"}' '{"t":"sub","stream":"home"}' '{"t":"cmd","id":"ws-v1","op":"nope"}' '{"t":"sub","stream":"conv:999999"}'
```

Expected: `open protocol=xin`, Pong, a home snap, a rejected ack, and `unknown stream conv:999999`.

## Gotchas

- A browser only accepts the upgrade if the server echoes a protocol it offered. The Worker sets it when `xin` is in the list.
- Conversation snapshots after an eviction are proven in the gate (`src/wire.test.ts`), because HTTP can't evict.

Evidence from the last wrangler dev drive: `.verify/evidence/M1-commands-socket.txt`.
