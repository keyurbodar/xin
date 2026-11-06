#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RUN="${XIN_RUN:-$ROOT/.verify}"
PORT="${XIN_PORT:-8799}"
TOKEN="${XIN_TOKEN:-verify-owner-token}"
KEK="dmVyaWZ5LWtlay0zMi1ieXRlcy1sb25nLTEyMzQ1Njc4OQ=="
URL="http://127.0.0.1:$PORT"
mkdir -p "$RUN/evidence" "$RUN/state"

case "${1:-}" in
  launch)
    if [ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then echo "already running pid $(cat "$RUN/pid")"; exit 0; fi
    if curl -fsS "$URL/health" >/dev/null 2>&1; then echo "port $PORT is taken by another process; set XIN_PORT" >&2; exit 1; fi
    cd "$ROOT"
    setsid bunx wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$RUN/state" \
      --var "OWNER_TOKEN:$TOKEN" --var "KEK:$KEK" >"$RUN/wrangler.log" 2>&1 &
    echo $! >"$RUN/pid"
    for _ in $(seq 1 120); do
      if curl -fsS "$URL/health" >/dev/null 2>&1; then echo "ready $URL pid $(cat "$RUN/pid")"; exit 0; fi
      sleep 0.5
    done
    echo "not ready after 60s; see $RUN/wrangler.log" >&2; exit 1 ;;
  doctor)
    [ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null || { echo "doctor: no instance started from $RUN"; exit 1; }
    [ "$(curl -s "$URL/health")" = "ok" ] || { echo "doctor: /health does not answer ok"; exit 1; }
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$URL/v1/status")
    [ "$code" = "200" ] || { echo "doctor: token rejected ($code)"; exit 1; }
    echo "doctor: ok pid $(cat "$RUN/pid") $URL" ;;
  call)
    method="$2"; path="$3"; body="${4:-}"
    args=(-s -w '\nHTTP %{http_code}\n' -X "$method" -H "authorization: Bearer $TOKEN")
    [ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
    curl "${args[@]}" "$URL$path" ;;
  ws)
    shift
    bun "$(dirname "$0")/ws.ts" "ws://127.0.0.1:$PORT/v1/socket" "$TOKEN" "$@" ;;
  stop)
    if [ -f "$RUN/pid" ]; then
      pid="$(cat "$RUN/pid")"
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 -- "-$pid" 2>/dev/null || true
      rm -f "$RUN/pid"
    fi
    rm -rf "$RUN/state"
    echo "stopped; evidence kept in $RUN/evidence" ;;
  *) cat <<'USAGE'
xin.sh launch | doctor | call METHOD PATH [JSON] | ws FRAME_JSON... | stop
env: XIN_PORT (8799), XIN_RUN (.verify), XIN_TOKEN (verify-owner-token)
USAGE
     exit 2 ;;
esac
