#!/usr/bin/env bash
# Health check + auto-start for the church signage (photo wall) on this box.
#
# Checks that both processes started by start_signage.sh are alive:
#   - server  (node server.js, serves the display on :8000)
#   - bridge  (node signage_bridge.js, mirrors Firestore -> control/content.json)
# If either is down, runs ./start_signage.sh once and re-checks.
#
# Output is machine-readable for the n8n "Automation Media" workflow:
#   SIGNAGE_SERVER=up|down   SIGNAGE_BRIDGE=up|down   SIGNAGE_MODE=<display mode>
#   SIGNAGE_ACTION=none|started|start_failed   SIGNAGE_RESULT=0|1
# followed by one JSON result line. Exit code 0 = signage is running.
#
# Usage (on the VM):  ~/photowall/check_signage.sh

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
PORT="${PORT:-8000}"

cd "$ROOT_DIR"
mkdir -p "$LOG_DIR" "$RUN_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

proc_alive() {
  local pid_file="$RUN_DIR/$1.pid"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

http_ok() {
  curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${PORT}/"
}

check_status() {
  server=down
  bridge=down
  if proc_alive server && http_ok; then
    server=up
  fi
  if proc_alive bridge; then
    bridge=up
  fi
}

current_mode() {
  python3 - <<'EOF' 2>/dev/null || echo unknown
import json
print(json.load(open('control.json')).get('mode', 'unknown'))
EOF
}

check_status
action=none

if [[ "$server" != up || "$bridge" != up ]]; then
  log "Signage not fully running (server=$server bridge=$bridge) - starting"
  if ./start_signage.sh >>"$LOG_DIR/check_signage.log" 2>&1; then
    action=started
  else
    action=start_failed
    log "start_signage.sh failed - see $LOG_DIR/check_signage.log"
  fi
  sleep 3
  check_status
else
  log "Signage already running"
fi

result=1
if [[ "$server" == up && "$bridge" == up ]]; then
  result=0
fi

mode="$(current_mode)"

echo "SIGNAGE_SERVER=$server"
echo "SIGNAGE_BRIDGE=$bridge"
echo "SIGNAGE_MODE=$mode"
echo "SIGNAGE_ACTION=$action"
echo "SIGNAGE_RESULT=$result"

if [[ $result -eq 0 ]]; then
  if [[ "$action" == started ]]; then
    msg="Signage was down and has been restarted (mode: $mode)"
  else
    msg="Signage is running (mode: $mode)"
  fi
  printf '{"success":true,"action":"signage-check","message":"%s"}\n' "$msg"
else
  printf '{"success":false,"action":"signage-check","message":"Signage is not running (server=%s, bridge=%s, start=%s)"}\n' \
    "$server" "$bridge" "$action"
fi

exit $result
