# Health check

`GET /health` answers `ok` without a token. It is the readiness signal for `xin.sh launch`.

## Sub-features

- Unauthenticated liveness only. It never touches the Home DO.

## How to get to it (user POV)

A load balancer or the web client probes `https://<worker>/health`.

## Driving it with xin.sh

```bash
curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:8799/health   # ok / HTTP 200
```

## Gotchas

- It answers even when the DO would fail to open, so it proves the Worker is up, not the Home.

Evidence from the last wrangler dev drive: `.verify/evidence/M0-auth.txt`.
