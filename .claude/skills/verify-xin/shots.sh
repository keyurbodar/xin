#!/usr/bin/env bash
# Capture every client route once for visual review.
# usage: xin-shots.sh [outdir] [base]
set -u
out=${1:-.verify/shots}
base=${2:-http://localhost:5174}
mkdir -p "$out"
out=$(cd "$out" && pwd)

shot() {
  local name=$1 route=$2
  agent-browser open "$base/#$route" >/dev/null 2>&1
  sleep 2
  agent-browser screenshot "$out/$name.png" >/dev/null 2>&1 && echo "ok $name"
}

shot home /
shot inbox /inbox
shot extensions /extensions
shot settings-general /settings/general
shot settings-usage /settings/usage
shot settings-models /settings/models
shot schedules /schedules
shot welcome /welcome
shot landing /landing
shot new /new

agent-browser viewport 390 844 >/dev/null 2>&1
shot mobile-home /
shot mobile-inbox /inbox
