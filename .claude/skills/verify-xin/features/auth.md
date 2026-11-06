# Owner auth

Every route except `/health` needs the owner's token. It is compared in constant time with `OWNER_TOKEN`. Clients send it as `Authorization: Bearer <token>`, or as the WebSocket subprotocol `bearer.<token>`.

## Sub-features

- Bearer header.
- WebSocket subprotocol form (`sec-websocket-protocol: xin, bearer.<token>`).
- Missing, wrong or empty-configured token gives 401.

## How to get to it (user POV)

The web client attaches the token to every API call and socket upgrade.

## Driving it with xin.sh

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8799/v1/status                                   # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer nope' http://127.0.0.1:8799/v1/status    # 401
.claude/skills/verify-xin/xin.sh call GET /v1/status                                                      # HTTP 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'sec-websocket-protocol: xin, bearer.verify-owner-token' http://127.0.0.1:8799/v1/status  # 200
```

## Gotchas

- An empty `OWNER_TOKEN` rejects everyone by design.
- All owners route to one Home (`idFromName("owner")`). Xin is single-owner per deployment.
