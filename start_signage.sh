#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
RUN_DIR="$ROOT_DIR/run"
PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
DISPLAY_HOST="${DISPLAY_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"

cd "$ROOT_DIR"
mkdir -p "$LOG_DIR" "$RUN_DIR"

for command_name in node npm python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if [[ -f serviceAccountKey.json ]]; then
  chmod 600 serviceAccountKey.json
fi
if [[ -f signage.config.json ]]; then
  chmod 600 signage.config.json
fi

stop_recorded_process() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"

  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$pid_file"
}

stop_recorded_process bridge
stop_recorded_process server

nohup node signage_bridge.js >>"$LOG_DIR/bridge.log" 2>&1 </dev/null &
bridge_pid=$!
echo "$bridge_pid" >"$RUN_DIR/bridge.pid"

nohup env HOST="$HOST" PORT="$PORT" DISPLAY_HOST="$DISPLAY_HOST" \
  node server.js >>"$LOG_DIR/server.log" 2>&1 </dev/null &
server_pid=$!
echo "$server_pid" >"$RUN_DIR/server.pid"

sleep 1
kill -0 "$bridge_pid"
kill -0 "$server_pid"

echo "Signage started."
echo "Display: http://${DISPLAY_HOST:-localhost}:$PORT/"
echo "Bridge log: $LOG_DIR/bridge.log"
echo "Server log: $LOG_DIR/server.log"
