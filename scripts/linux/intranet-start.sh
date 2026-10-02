#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"
ai4es_load_env "$PROJECT_ROOT"
ulimit -n 65535 2>/dev/null || true

MODE="${AI4ES_MODE:-${1:-prod}}"
PORT="${PORT:-3000}"
API_PORT="${API_PORT:-4000}"
OPENCODE_PORT=4097
TSX="$PROJECT_ROOT/node_modules/tsx/dist/cli.mjs"
NEXT="$PROJECT_ROOT/node_modules/next/dist/bin/next"
PIDS="$PROJECT_ROOT/storage/intranet.pids.json"

if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
  echo "Missing node_modules. Run scripts/linux/install-runtime.sh first." >&2
  exit 1
fi
ai4es_ensure_empty_corpus "$PROJECT_ROOT"
if [[ ! -f "$PROJECT_ROOT/storage/knowledge-corpus/MANIFEST.md" ]]; then
  echo "Missing corpus manifest." >&2
  exit 1
fi

echo "[intranet] checking PostgreSQL..."
if [[ -f "$PROJECT_ROOT/dist/runtime/check-postgres.mjs" ]]; then
  node "$PROJECT_ROOT/dist/runtime/check-postgres.mjs"
else
  npx tsx "$PROJECT_ROOT/scripts/check-postgres.ts"
fi

echo "[intranet] starting OpenCode sidecar..."
bash "$SCRIPT_DIR/opencode-sidecar.sh" start

export OMG_PORT="${OMG_PORT:-18088}"
if [[ "$OMG_PORT" == "8088" ]]; then
  export OMG_PORT=18088
fi
if [[ -z "${OPENMODELICA_GATEWAY_URL:-}" || "${OPENMODELICA_GATEWAY_URL}" == *":8088"* ]]; then
  export OPENMODELICA_GATEWAY_URL="http://127.0.0.1:$OMG_PORT"
fi

if [[ -x "$PROJECT_ROOT/tools/openmodelica-gateway-venv/bin/python" ]]; then
  echo "[intranet] starting OpenModelica gateway..."
  bash "$SCRIPT_DIR/openmodelica-gateway.sh" start || echo "[intranet] OpenModelica gateway did not start."
fi

USE_PROD=0
if [[ "$MODE" =~ ^prod ]]; then
  USE_PROD=1
  if [[ ! -d "$PROJECT_ROOT/.next" ]]; then
    echo "Prod mode requires npm run build first." >&2
    exit 1
  fi
fi

mkdir -p "$PROJECT_ROOT/storage"

write_pids() {
  python3 - "$PIDS" "$1" "$2" "$3" "$PORT" "$API_PORT" "$OPENCODE_PORT" "$MODE" <<'PY'
import json,sys,datetime
path,api,worker,web,port,api_port,oc,mode=sys.argv[1:9]
json.dump({
  "at": datetime.datetime.utcnow().isoformat()+"Z",
  "mode": "prod" if mode.startswith("prod") else "dev",
  "api": int(api) if api.isdigit() else None,
  "worker": int(worker) if worker.isdigit() else None,
  "web": int(web) if web.isdigit() else None,
  "ports": {"web": int(port), "api": int(api_port), "opencode": int(oc)}
}, open(path,'w',encoding='utf-8'), indent=2)
PY
}

start_api() {
  ai4es_kill_port "$API_PORT"
  export AI4ES_ROLE=api
  export AI4ES_USE_JOB_QUEUE=1
  export API_PORT
  export API_HOST=127.0.0.1
  if [[ "${AI4ES_FORCE_TSX:-0}" != 1 && -f "$PROJECT_ROOT/dist/runtime/api.mjs" ]]; then
    nohup node "$PROJECT_ROOT/dist/runtime/api.mjs" \
      >"$PROJECT_ROOT/storage/api-server.out.log" \
      2>"$PROJECT_ROOT/storage/api-server.err.log" &
  else
    nohup node "$TSX" server/api/index.ts \
      >"$PROJECT_ROOT/storage/api-server.out.log" \
      2>"$PROJECT_ROOT/storage/api-server.err.log" &
  fi
  echo $!
}

start_worker() {
  export AI4ES_ROLE=worker
  export AI4ES_USE_JOB_QUEUE=0
  if [[ "${AI4ES_FORCE_TSX:-0}" != 1 && -f "$PROJECT_ROOT/dist/runtime/worker.mjs" ]]; then
    nohup node "$PROJECT_ROOT/dist/runtime/worker.mjs" \
      >"$PROJECT_ROOT/storage/worker.out.log" \
      2>"$PROJECT_ROOT/storage/worker.err.log" &
  else
    nohup node "$TSX" server/worker/index.ts \
      >"$PROJECT_ROOT/storage/worker.out.log" \
      2>"$PROJECT_ROOT/storage/worker.err.log" &
  fi
  echo $!
}

start_web() {
  ai4es_kill_port "$PORT"
  export AI4ES_SPLIT=1
  export AI4ES_API_URL="http://127.0.0.1:$API_PORT"
  unset AI4ES_ROLE || true
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=3072"
  local args
  if [[ "$USE_PROD" == 1 ]]; then
    nohup node "$NEXT" start --hostname=:: -p "$PORT" \
      >"$PROJECT_ROOT/storage/web-server.out.log" \
      2>"$PROJECT_ROOT/storage/web-server.err.log" &
  else
    nohup node "$NEXT" dev --webpack --hostname=:: -p "$PORT" \
      >"$PROJECT_ROOT/storage/web-server.out.log" \
      2>"$PROJECT_ROOT/storage/web-server.err.log" &
  fi
  echo $!
}

stop_all() {
  echo "[intranet] stopping..."
  [[ -n "${WEB_PID:-}" ]] && kill -TERM "$WEB_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill -TERM "$WORKER_PID" 2>/dev/null || true
  [[ -n "${API_PID:-}" ]] && kill -TERM "$API_PID" 2>/dev/null || true
  ai4es_kill_port "$PORT"
  ai4es_kill_port "$API_PORT"
  rm -f "$PIDS"
}

trap stop_all EXIT
trap 'stop_all; exit 0' INT TERM

echo "[intranet] starting API (:$API_PORT)..."
API_PID="$(start_api)"
if ! ai4es_wait_http "http://127.0.0.1:$API_PORT/api/health" 90; then
  echo "API not ready. See storage/api-server.err.log" >&2
  exit 1
fi
echo "[intranet] API ready"

echo "[intranet] starting Worker..."
WORKER_PID="$(start_worker)"

echo "[intranet] starting Web (:$PORT)..."
WEB_PID="$(start_web)"
if ! ai4es_wait_http "http://127.0.0.1:$PORT/healthz" 180; then
  echo "Web not ready. See storage/web-server.err.log" >&2
  exit 1
fi
write_pids "$API_PID" "$WORKER_PID" "$WEB_PID"

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "========================================"
echo "  AI4ES ready (split architecture)"
echo "  Web:        http://localhost:$PORT"
echo "  API:        http://localhost:$API_PORT"
echo "  OpenCode:   http://localhost:$OPENCODE_PORT"
echo "  LAN:        http://${LAN_IP:-10.1.4.166}:$PORT"
echo "  Mode:       $MODE"
echo "========================================"
echo

GATEWAY_HEALTH="http://127.0.0.1:${LLM_GATEWAY_PORT:-4098}/health"
api_fail=0
web_fail=0
gateway_fail=0
opencode_fail=0
while true; do
  sleep 12
  if curl -fsS -m 5 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
    api_fail=0
    if ! kill -0 "$API_PID" 2>/dev/null; then
      API_PID="$(ai4es_listen_pid "$API_PORT" || echo "$API_PID")"
    fi
  else
    api_fail=$((api_fail + 1))
    if (( api_fail >= 2 )); then
      echo "[intranet] API unhealthy — restarting..."
      kill -TERM "$API_PID" 2>/dev/null || true
      API_PID="$(start_api)"
      ai4es_wait_http "http://127.0.0.1:$API_PORT/api/health" 90 || true
      api_fail=0
    fi
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[intranet] Worker exited — restarting..."
    WORKER_PID="$(start_worker)"
  fi
  if curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    web_fail=0
  else
    web_fail=$((web_fail + 1))
    if (( web_fail >= 6 )); then
      echo "[intranet] Web unhealthy — restarting..."
      kill -TERM "$WEB_PID" 2>/dev/null || true
      WEB_PID="$(start_web)"
      ai4es_wait_http "http://127.0.0.1:$PORT/healthz" 120 || true
      web_fail=0
    fi
  fi
  # Every chat request goes OpenCode -> LLM gateway -> model. If either is down,
  # chat fails with "Cannot connect to API" while Web and API still look healthy.
  if curl -fsS -m 5 "$GATEWAY_HEALTH" >/dev/null 2>&1; then
    gateway_fail=0
  else
    gateway_fail=$((gateway_fail + 1))
    if (( gateway_fail >= 2 )); then
      echo "[intranet] $(date -Is) LLM gateway unhealthy — restarting..."
      bash "$SCRIPT_DIR/opencode-sidecar.sh" ensure-gateway || true
      gateway_fail=0
    fi
  fi
  if bash "$SCRIPT_DIR/opencode-sidecar.sh" status 2>/dev/null | grep -q '"healthy": true'; then
    opencode_fail=0
  else
    opencode_fail=$((opencode_fail + 1))
    if (( opencode_fail >= 3 )); then
      echo "[intranet] $(date -Is) OpenCode unhealthy — restarting sidecar..."
      bash "$SCRIPT_DIR/opencode-sidecar.sh" start || true
      opencode_fail=0
    fi
  fi
  write_pids "$API_PID" "$WORKER_PID" "$WEB_PID"
done
