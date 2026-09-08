#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT="23390"
API_PORT="23391"
GATEWAY_PORT="23392"
DEPLOY_DATA_DIR="$ROOT_DIR/.data/deployment"
PID_FILE="$DEPLOY_DATA_DIR/worklite-local.pid"
LOG_FILE="$DEPLOY_DATA_DIR/worklite-local.log"

cd "$ROOT_DIR"
mkdir -p "$DEPLOY_DATA_DIR"

clear_port() {
  local port="$1"
  local pids pid
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ -n "$pids" ]]; then
    sleep 0.2
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

stop_previous() {
  if [[ ! -f "$PID_FILE" ]]; then
    return
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$PID_FILE"
}

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building Portkey Gateway..."
pnpm --filter @portkey-ai/gateway build

echo "Building WorkLite Web..."
pnpm --filter @worklite/web exec vite build

stop_previous
clear_port "$WEB_PORT"
clear_port "$API_PORT"
clear_port "$GATEWAY_PORT"
rm -f "$PID_FILE"

export API_HOST="127.0.0.1"
export API_PORT
export PORTKEY_GATEWAY_PORT="$GATEWAY_PORT"
export SQLITE_PATH="$DEPLOY_DATA_DIR/worklite.db"
export PORTKEY_GATEWAY_DB_PATH="$DEPLOY_DATA_DIR/worklite-gateway.db"

echo "Starting WorkLite in the background on port $WEB_PORT..."
PID="$(node scripts/start-background.mjs "$LOG_FILE" "$PID_FILE")"

for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
    echo "WorkLite is running at http://127.0.0.1:$WEB_PORT/"
    echo "PID: $PID"
    echo "Log: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "WorkLite failed to start. See $LOG_FILE" >&2
    exit 1
  fi
  sleep 0.25
done

echo "WorkLite did not become ready. See $LOG_FILE" >&2
exit 1
