# Web push

Xin sends an encrypted Web Push (RFC 8291 `aes128gcm`, VAPID ES256, RFC 8030 `Topic`) to each stored subscription when no socket is connected. The VAPID key pair is generated on first use and kept in kv `vapid` as a JWK; the application server key is derived from its `x`/`y`.

## Sub-features

- `push.key`: the `applicationServerKey` for the browser's `pushManager.subscribe`. It is stable across calls.
- `push.subscribe` (upsert by endpoint) and `push.unsubscribe`. `push.subscribe` decodes the keys and rejects a `p256dh` that is not a 65-byte uncompressed P-256 point or an `auth` that is not 16 bytes with `bad_args`; nothing is stored.
- Delivery: one POST per subscription with `TTL`, `Urgency` and a `Topic` derived from the notification tag, so a retried notification replaces the earlier one. A 404 or 410 deletes that subscription; any other status or an unreachable endpoint is logged and the remaining subscriptions still receive the push. No push while any socket is open. The payload is truncated to one 4096-byte record.
- `notifier(deps)` is the export the orchestrator calls when a report or question lands.

## How to get to it (user POV)

The web client asks for notification permission, calls `push.key`, subscribes in the browser, then sends `push.subscribe`.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"k1","op":"push.key","args":{}}'
$S call POST /v1/cmd '{"id":"s1","op":"push.subscribe","args":{"endpoint":"https://push.example.invalid/sub/1","keys":{"p256dh":"BP9J1roMvjJFaN4XFZRB5XNDuFi3UMM59qBNHbzvVul53DUVju5i1HqZCcEddfqFg6x5Wl8sqK5J5B7nMAW55UI","auth":"AFpgjbqtf8syCsO2VMPhJw"}}}'
$S call POST /v1/cmd '{"id":"u1","op":"push.unsubscribe","args":{"endpoint":"https://push.example.invalid/sub/1"}}'
```

The sample keys are a real P-256 pair generated for this example; they are not secrets. A malformed key answers `{"ok":false,"error":{"code":"bad_args",...}}`.

Encryption, VAPID claims, record budget and pruning are proven in `src/push.test.ts` and `src/webpush.test.ts`, which decrypt the captured POST bodies.

## Gotchas

- Delivery can't be observed under wrangler dev without a real push service. Use the tests.
