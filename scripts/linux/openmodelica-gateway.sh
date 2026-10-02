#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
ai4es_load_env "$PROJECT_ROOT"

ACTION="${1:-status}"
PID_FILE="$PROJECT_ROOT/storage/openmodelica-gateway.pid"
OUT="$PROJECT_ROOT/storage/openmodelica-gateway.out.log"
ERR="$PROJECT_ROOT/storage/openmodelica-gateway.err.log"
PY="$PROJECT_ROOT/tools/openmodelica-gateway-venv/bin/python"
APP="$PROJECT_ROOT/tools/openmodelica-gateway"
PORT="${OMG_PORT:-18088}"
export OMG_PORT="$PORT"
export OPENMODELICA_GATEWAY_URL="${OPENMODELICA_GATEWAY_URL:-http://127.0.0.1:$PORT}"

if [[ -z "${OPENMODELICAHOME:-}" ]]; then
  for candidate in /usr /usr/lib/x86_64-linux-gnu /opt/openmodelica; do
    if [[ -x "$candidate/bin/omc" ]]; then
      export OPENMODELICAHOME="$candidate"
      break
    fi
  done
fi
if [[ -n "${OPENMODELICA_OMC:-}" && -x "${OPENMODELICA_OMC}" ]]; then
  export PATH="$(dirname "$OPENMODELICA_OMC"):$PATH"
fi
if command -v omc >/dev/null 2>&1; then
  export OPENMODELICA_OMC="${OPENMODELICA_OMC:-$(command -v omc)}"
fi

is_our_gateway() {
  local body
  body="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 1
  printf '%s' "$body" | grep -q 'openmodelica-agent-gateway'
}

port_occupied_by_other() {
  local body
  body="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [[ -n "$body" ]] || return 1
  printf '%s' "$body" | grep -q 'openmodelica-agent-gateway' && return 1
  return 0
}

start() {
  if [[ ! -x "$PY" ]]; then
    echo "OpenModelica gateway venv missing"
    exit 1
  fi
  if is_our_gateway; then
    echo "OpenModelica gateway already listening on $PORT"
    return 0
  fi
  if port_occupied_by_other; then
    echo "Port $PORT is occupied by another service. Set OMG_PORT/OPENMODELICA_GATEWAY_URL (default 18088)."
    exit 1
  fi
  if [[ -f "$PID_FILE" ]]; then
    kill -TERM "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  mkdir -p "$PROJECT_ROOT/storage"
  (
    cd "$APP"
    nohup "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" \
      >"$OUT" 2>"$ERR" &
    echo $! >"$PID_FILE"
  )
  local tries=0
  while (( tries < 20 )); do
    if is_our_gateway; then
      echo "OpenModelica gateway pid $(cat "$PID_FILE") on $PORT"
      return 0
    fi
    # process up, health may be ok:false until omc exists
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q 'openmodelica-agent-gateway'; then
      echo "OpenModelica gateway listening on $PORT (omc may still be missing). pid $(cat "$PID_FILE")"
      return 0
    fi
    sleep 0.5
    tries=$((tries + 1))
  done
  echo "OpenModelica gateway did not become reachable. See $ERR"
  return 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    kill -TERM "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
}

status() {
  local body
  body="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/health" || true)"
  if [[ -z "$body" ]]; then
    echo '{"ok":false,"error":"unreachable"}'
    exit 1
  fi
  printf '%s\n' "$body"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); raise SystemExit(0 if d.get("ok") else 1)' "$body"
}

case "$ACTION" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 1 ;;
esac
