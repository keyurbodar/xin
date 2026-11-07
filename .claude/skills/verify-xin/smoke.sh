#!/usr/bin/env bash
# Route smoke: every client route must render something and log no console error.
# usage: smoke.sh [base]
set -u
base=${1:-http://localhost:5174}
fail=0
agent-browser console --clear >/dev/null 2>&1

check() {
  local route=$1
  agent-browser open "$base/#$route" >/dev/null 2>&1
  sleep 1
  local text
  text=$(agent-browser eval "document.body.innerText.trim().length" 2>/dev/null | tr -d '"')
  if [ "${text:-0}" -lt 20 ]; then
    echo "FAIL $route (empty: ${text:-0} chars)"
    fail=1
  else
    echo "ok   $route"
  fi
}

check /
check /inbox
check /extensions
check /settings/general
check /settings/usage
check /settings/models
check /schedules
check /welcome
check /landing
check /new

errors=$(agent-browser console 2>/dev/null | grep -c "\[error\]" || true)
if [ "${errors:-0}" -gt 0 ]; then
  echo "console errors: $errors"
  agent-browser console 2>/dev/null | grep "\[error\]" | tail -5
  fail=1
fi

exit $fail
