#!/usr/bin/env bash
# Capture every client route once for visual review. Signed-in state is the caller's job:
# take the sign-in step in the same AGENT_BROWSER_SESSION before running this.
# usage: shots.sh [outdir] [base]
set -u
out=${1:-.verify/shots}
base=${2:-http://localhost:5174}
mkdir -p "$out"
out=$(cd "$out" && pwd)

# This agent-browser build reads `screenshot [selector] [path]`; without the selector the
# path is taken as a selector and the image lands in a temp dir instead.
shot() {
  local name=$1 route=$2
  agent-browser open "$base/#$route" >/dev/null 2>&1
  sleep 2
  agent-browser screenshot body "$out/$name.png" >/dev/null 2>&1 && echo "ok $name"
}

shot home /
shot inbox /inbox
shot extensions /extensions
shot settings-general /settings/general
shot settings-usage /settings/usage
shot settings-models /settings/models
shot settings-notifications /settings/notifications
shot settings-profile /settings/profile
shot settings-system /settings/system
shot schedules /schedules
shot welcome /welcome
shot landing /landing
shot new /new

# Phone width needs a fresh browser, because there is no `viewport` command and a relaunch
# drops the stored token: agent-browser close --all && agent-browser --args
# "--window-size=390,844" open "$base/#/" , then sign in again.
