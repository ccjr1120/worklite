#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_PORT="23390"
API_PORT="23391"
GATEWAY_PORT="23392"
PREFLIGHT_WEB_PORT="23490"
PREFLIGHT_API_PORT="23491"
PREFLIGHT_GATEWAY_PORT="23492"
DEPLOY_DATA_DIR="$ROOT_DIR/.data/deployment"
PID_FILE="$DEPLOY_DATA_DIR/worklite-local.pid"
LOG_FILE="$DEPLOY_DATA_DIR/worklite-local.log"
PREFLIGHT_LOG_FILE="$DEPLOY_DATA_DIR/worklite-preflight.log"
PREFLIGHT_DATA_DIR=""
PREFLIGHT_PID=""
PREFLIGHT_PASSED="false"

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

assert_port_free() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Preflight port $port is already in use; refusing to stop that process." >&2
    return 1
  fi
}

stop_preflight() {
  if [[ ! "$PREFLIGHT_PID" =~ ^[0-9]+$ ]]; then
    return
  fi

  kill "$PREFLIGHT_PID" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "$PREFLIGHT_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$PREFLIGHT_PID" 2>/dev/null || true
  wait "$PREFLIGHT_PID" 2>/dev/null || true
  PREFLIGHT_PID=""
}

cleanup_preflight() {
  stop_preflight
  if [[ -n "$PREFLIGHT_DATA_DIR" && -d "$PREFLIGHT_DATA_DIR" ]]; then
    rm -rf "$PREFLIGHT_DATA_DIR"
  fi
  if [[ "$PREFLIGHT_PASSED" == "true" ]]; then
    rm -f "$PREFLIGHT_LOG_FILE"
  fi
}

trap cleanup_preflight EXIT

wait_for_ready() {
  local pid="$1"
  local web_port="$2"
  local api_port="$3"
  local gateway_port="$4"
  local log_file="$5"
  local attempts="$6"

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl -fsS "http://127.0.0.1:$web_port/" >/dev/null 2>&1 \
      && curl -fsS "http://127.0.0.1:$api_port/api/health" >/dev/null 2>&1 \
      && curl -fsS "http://127.0.0.1:$gateway_port/" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "WorkLite failed to start. See $log_file" >&2
      return 1
    fi
    sleep 0.25
  done

  echo "WorkLite did not become ready. See $log_file" >&2
  return 1
}

run_preflight() {
  assert_port_free "$PREFLIGHT_WEB_PORT"
  assert_port_free "$PREFLIGHT_API_PORT"
  assert_port_free "$PREFLIGHT_GATEWAY_PORT"

  PREFLIGHT_DATA_DIR="$(mktemp -d "$DEPLOY_DATA_DIR/worklite-preflight.XXXXXX")"
  rm -f "$PREFLIGHT_LOG_FILE"

  (
    export API_HOST="127.0.0.1"
    export API_PORT="$PREFLIGHT_API_PORT"
    export WEB_PORT="$PREFLIGHT_WEB_PORT"
    export PORTKEY_GATEWAY_PORT="$PREFLIGHT_GATEWAY_PORT"
    export SQLITE_PATH="$PREFLIGHT_DATA_DIR/worklite.db"
    export PORTKEY_GATEWAY_DB_PATH="$PREFLIGHT_DATA_DIR/worklite-gateway.db"
    exec node scripts/start-local.mjs
  ) >"$PREFLIGHT_LOG_FILE" 2>&1 &
  PREFLIGHT_PID=$!

  wait_for_ready "$PREFLIGHT_PID" "$PREFLIGHT_WEB_PORT" "$PREFLIGHT_API_PORT" "$PREFLIGHT_GATEWAY_PORT" "$PREFLIGHT_LOG_FILE" 120
}

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building Portkey Gateway..."
pnpm --filter @portkey-ai/gateway build

echo "Building WorkLite Web..."
pnpm --filter @worklite/web exec vite build

echo "Preflighting WorkLite on isolated ports..."
run_preflight
echo "Preflight passed; replacing the deployment services..."
stop_preflight
PREFLIGHT_PASSED="true"

stop_previous
clear_port "$WEB_PORT"
clear_port "$API_PORT"
clear_port "$GATEWAY_PORT"
rm -f "$PID_FILE"

export API_HOST="127.0.0.1"
export API_PORT
export WEB_PORT
export PORTKEY_GATEWAY_PORT="$GATEWAY_PORT"
export SQLITE_PATH="$DEPLOY_DATA_DIR/worklite.db"
export PORTKEY_GATEWAY_DB_PATH="$DEPLOY_DATA_DIR/worklite-gateway.db"

echo "Starting WorkLite in the background on port $WEB_PORT..."
PID="$(node scripts/start-background.mjs "$LOG_FILE" "$PID_FILE")"

wait_for_ready "$PID" "$WEB_PORT" "$API_PORT" "$GATEWAY_PORT" "$LOG_FILE" 60
echo "WorkLite is running at http://127.0.0.1:$WEB_PORT/"
echo "PID: $PID"
echo "Log: $LOG_FILE"
