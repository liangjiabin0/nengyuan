#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ai4es_load_env "$PROJECT_ROOT"

STORAGE="$PROJECT_ROOT/storage"
TOOL_ROOT="$PROJECT_ROOT/tools/opencode"
EXE="$TOOL_ROOT/opencode"
RG_ROOT="$PROJECT_ROOT/tools/ripgrep"
STATE="$STORAGE/opencode-sidecar.json"
STDOUT_LOG="$STORAGE/opencode-sidecar.out.log"
STDERR_LOG="$STORAGE/opencode-sidecar.err.log"
GATEWAY_SCRIPT="$PROJECT_ROOT/scripts/llm-gateway.mjs"
GATEWAY_SUPERVISOR="$SCRIPT_DIR/llm-gateway-supervise.sh"
GATEWAY_OUT="$STORAGE/llm-gateway.out.log"
GATEWAY_ERR="$STORAGE/llm-gateway.err.log"
CORPUS="$STORAGE/knowledge-corpus/MANIFEST.md"
ai4es_ensure_empty_corpus "$PROJECT_ROOT"
RUNTIME_CONFIG="$STORAGE/opencode.linux.json"
ACTION="${1:-status}"

gateway_port() { echo "${LLM_GATEWAY_PORT:-4098}"; }
gateway_url() { echo "http://127.0.0.1:$(gateway_port)/v1"; }

random_token() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
}

json_get() {
  local file="$1" key="$2"
  python3 - "$file" "$key" <<'PY'
import json,sys
path,key=sys.argv[1],sys.argv[2]
try:
    data=json.load(open(path,encoding='utf-8'))
except Exception:
    sys.exit(0)
val=data
for part in key.split('.'):
    if isinstance(val,dict) and part in val:
        val=val[part]
    else:
        sys.exit(0)
if val is None:
    sys.exit(0)
print(val)
PY
}

write_runtime_config() {
  python3 - "$PROJECT_ROOT/opencode.json" "$RUNTIME_CONFIG" "$PROJECT_ROOT/scripts/esopt-mcp.sh" <<'PY'
import json,sys
src,dst,launcher=sys.argv[1],sys.argv[2],sys.argv[3]
cfg=json.load(open(src,encoding='utf-8'))
mcp=cfg.setdefault('mcp',{}).setdefault('esopt',{})
mcp['type']='local'
mcp['command']=['bash', launcher]
mcp['enabled']=True
mcp['timeout']=120000
json.dump(cfg, open(dst,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
print(dst)
PY
}

gateway_health() {
  local url health
  url="$(gateway_url)"
  health="${url%/v1}/health"
  curl -fsS -m 2 "$health" >/dev/null 2>&1
}

stop_gateway() {
  local pid
  pid="$(json_get "$STATE" gatewayPid || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  # The supervisor restarts the gateway, so it has to go before the port is freed.
  pkill -TERM -f "$GATEWAY_SUPERVISOR" 2>/dev/null || true
  sleep 0.5
  ai4es_kill_port "$(gateway_port)"
}

start_gateway() {
  stop_gateway
  export LLM_GATEWAY_PORT
  LLM_GATEWAY_PORT="$(gateway_port)"
  export LLM_GATEWAY_HOST=127.0.0.1
  echo "[llm-gateway] $(date -Is) starting" >>"$GATEWAY_ERR"
  setsid nohup bash "$GATEWAY_SUPERVISOR" "$GATEWAY_SCRIPT" "$GATEWAY_OUT" "$GATEWAY_ERR"     >/dev/null 2>&1 </dev/null &
  local pid=$!
  local i
  # A heavily loaded host can take several seconds to boot node.
  for i in $(seq 1 150); do
    if gateway_health; then
      echo "$pid"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  echo "LLM gateway failed. See $GATEWAY_ERR" >&2
  return 1
}

# Restart only the gateway. OpenCode keeps its sessions; it always talks to the
# fixed local gateway URL, so it reconnects on its next model request.
ensure_gateway() {
  if gateway_health; then
    echo "LLM gateway healthy at $(gateway_url)"
    return 0
  fi
  local gpid
  gpid="$(start_gateway)" || return 1
  if [[ -f "$STATE" ]]; then
    python3 - "$STATE" "$gpid" <<'PY'
import json,sys
path,pid=sys.argv[1],int(sys.argv[2])
data=json.load(open(path,encoding='utf-8'))
data['gatewayPid']=pid
json.dump(data, open(path,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
PY
  fi
  echo "LLM gateway restarted at $(gateway_url) (supervisor $gpid)"
}

opencode_health() {
  local base user pass
  base="$(json_get "$STATE" baseUrl || true)"
  user="$(json_get "$STATE" username || true)"
  pass="$(json_get "$STATE" password || true)"
  [[ -n "$base" && -n "$user" && -n "$pass" ]] || return 1
  curl -fsS -m 3 -u "$user:$pass" "$base/global/health" >/dev/null 2>&1
}

write_state() {
  python3 - "$@" <<'PY'
import json,sys
path=sys.argv[1]
data={}
i=2
while i<len(sys.argv):
    data[sys.argv[i]]=sys.argv[i+1]
    i+=2
# coerce numeric-looking pids
for key in ('pid','gatewayPid'):
    if key in data:
        try: data[key]=int(data[key])
        except Exception: pass
json.dump(data, open(path,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
PY
  chmod 600 "$STATE" 2>/dev/null || true
}

start_sidecar() {
  mkdir -p "$STORAGE"
  if [[ ! -f "$CORPUS" ]]; then
    echo "Missing corpus manifest: $CORPUS" >&2
    exit 1
  fi
  if [[ ! -x "$EXE" ]]; then
    echo "OpenCode binary missing: $EXE" >&2
    echo "Place the linux-x64 binary at tools/opencode/opencode" >&2
    exit 1
  fi
  if [[ ! -x "$RG_ROOT/rg" ]]; then
    if command -v rg >/dev/null 2>&1; then
      mkdir -p "$RG_ROOT"
      ln -sfn "$(command -v rg)" "$RG_ROOT/rg"
    else
      echo "ripgrep missing. apt install ripgrep or put rg in $RG_ROOT" >&2
      exit 1
    fi
  fi

  mkdir -p "$STORAGE/.opencode"
  for kind in agents skills; do
    if [[ -d "$STORAGE/.opencode/$kind" && ! -L "$STORAGE/.opencode/$kind" ]]; then
      # Preserve user-customized runtime files; install newly bundled resources.
      rsync -a --ignore-existing "$PROJECT_ROOT/.opencode/$kind/" "$STORAGE/.opencode/$kind/"
    else
      ln -sfn "$PROJECT_ROOT/.opencode/$kind" "$STORAGE/.opencode/$kind"
    fi
  done
  write_runtime_config

  local existing_pid
  existing_pid="$(json_get "$STATE" pid || true)"
  if [[ -n "${existing_pid:-}" ]] && kill -0 "$existing_pid" 2>/dev/null && opencode_health && gateway_health; then
    echo "OpenCode sidecar is already healthy at $(json_get "$STATE" baseUrl)"
    return 0
  fi
  if [[ -n "${existing_pid:-}" ]]; then
    kill -TERM "$existing_pid" 2>/dev/null || true
  fi
  stop_gateway

  local port username password agent
  port="${OPENCODE_SERVER_PORT:-4097}"
  username="${OPENCODE_SERVER_USERNAME:-$(json_get "$STATE" username || true)}"
  username="${username:-opencode}"
  password="${OPENCODE_SERVER_PASSWORD:-$(json_get "$STATE" password || true)}"
  password="${password:-$(random_token)}"
  agent="${AI4ES_AGENT_API_TOKEN:-$(json_get "$STATE" agentApiToken || true)}"
  agent="${agent:-$(random_token)}"

  export OPENCODE_SERVER_USERNAME="$username"
  export OPENCODE_SERVER_PASSWORD="$password"
  export AI4ES_AGENT_API_TOKEN="$agent"
  export OPENCODE_CONFIG="$RUNTIME_CONFIG"
  export OPENCODE_CONFIG_DIR="$PROJECT_ROOT/.opencode"
  export OPENCODE_SKILLS_DIR="$PROJECT_ROOT/.opencode/skills"
  export PATH="$RG_ROOT:$PATH"

  local gpid
  gpid="$(start_gateway)" || exit 1
  export KNOWLEDGE_QA_BASE_URL
  KNOWLEDGE_QA_BASE_URL="$(gateway_url)"

  export ESOPT_ROOT="${ESOPT_ROOT:-$PROJECT_ROOT/tools/esopt}"
  export ESOPT_BRIDGE="${ESOPT_BRIDGE:-$PROJECT_ROOT/tools/esopt/esopt_bridge}"
  export ESOPT_NATIVE_ROOT="${ESOPT_NATIVE_ROOT:-$PROJECT_ROOT/tools/esopt}"
  if [[ -z "${ESOPT_PYTHON:-}" ]]; then
    if [[ -x "$PROJECT_ROOT/tools/esopt-venv/bin/python" ]]; then
      ESOPT_PYTHON="$PROJECT_ROOT/tools/esopt-venv/bin/python"
    else
      ESOPT_PYTHON="$(command -v python3)"
    fi
  fi
  export ESOPT_PYTHON
  export ESOPT_MCP_LAUNCHER="$PROJECT_ROOT/scripts/esopt-mcp.sh"

  ai4es_kill_port "$port"
  nohup "$EXE" serve --hostname 127.0.0.1 --port "$port" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
  local pid=$!
  write_state "$STATE" \
    pid "$pid" \
    baseUrl "http://127.0.0.1:$port" \
    username "$username" \
    password "$password" \
    agentApiToken "$agent" \
    executable "$EXE" \
    workingDirectory "$STORAGE" \
    startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    gatewayPid "$gpid" \
    gatewayUrl "$(gateway_url)"

  local i
  for i in $(seq 1 40); do
    if opencode_health; then
      echo "OpenCode sidecar ready at http://127.0.0.1:$port"
      echo "LLM gateway $(gateway_url)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  echo "OpenCode sidecar failed. See $STDERR_LOG" >&2
  kill -TERM "$pid" 2>/dev/null || true
  stop_gateway
  exit 1
}

stop_sidecar() {
  local pid
  pid="$(json_get "$STATE" pid || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    echo "Stopped OpenCode sidecar process $pid"
  else
    echo "OpenCode sidecar is not running"
  fi
  stop_gateway
  rm -f "$STATE"
}

status_sidecar() {
  python3 - "$STATE" "$(gateway_url)" <<'PY'
import json,os,sys,urllib.request,base64
path,gateway=sys.argv[1],sys.argv[2]
def alive(pid):
    try:
        os.kill(int(pid),0)
        return True
    except Exception:
        return False
try:
    st=json.load(open(path,encoding='utf-8'))
except Exception:
    print(json.dumps({"running":False,"healthy":False,"gateway":False}))
    raise SystemExit
running=alive(st.get('pid') or 0)
healthy=False
if running:
    try:
        token=base64.b64encode(f"{st['username']}:{st['password']}".encode()).decode()
        req=urllib.request.Request(st['baseUrl']+'/global/health', headers={'Authorization':'Basic '+token})
        with urllib.request.urlopen(req, timeout=3) as resp:
            healthy=resp.status==200
    except Exception:
        healthy=False
gw=False
try:
    health=gateway[:-3]+'/health' if gateway.endswith('/v1') else gateway+'/health'
    urllib.request.urlopen(health, timeout=2)
    gw=True
except Exception:
    gw=False
print(json.dumps({
    "running": running,
    "healthy": healthy,
    "version": None,
    "baseUrl": st.get("baseUrl"),
    "pid": st.get("pid"),
    "gateway": gw,
    "gatewayUrl": st.get("gatewayUrl") or gateway,
    "gatewayPid": st.get("gatewayPid"),
}))
PY
}

install_opencode() {
  local force="${1:-0}"
  if [[ -x "$EXE" && "$force" != 1 ]]; then
    echo "OpenCode already installed: $EXE"
    return 0
  fi
  mkdir -p "$TOOL_ROOT"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "Downloading latest OpenCode linux-x64..."
  curl -fsSL -A "electrical-system-opencode-installer" \
    -o "$tmp/opencode-linux-x64.tar.gz" \
    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x64.tar.gz"
  tar -xzf "$tmp/opencode-linux-x64.tar.gz" -C "$tmp"
  local bin
  bin="$(find "$tmp" -type f -name opencode | head -n1)"
  if [[ -z "$bin" ]]; then
    echo "Downloaded OpenCode archive does not contain opencode" >&2
    return 1
  fi
  install -m 755 "$bin" "$EXE"
  echo "Installed OpenCode $($EXE --version) at $EXE"
}

case "$ACTION" in
  install) install_opencode 0 ;;
  update)
    existing_pid="$(json_get "$STATE" pid || true)"
    was_running=0
    if [[ -n "${existing_pid:-}" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      was_running=1
      kill -TERM "$existing_pid" 2>/dev/null || true
      stop_gateway
    fi
    install_opencode 1
    if [[ "$was_running" == 1 ]]; then
      start_sidecar
    fi
    ;;
  start) start_sidecar ;;
  ensure-gateway) ensure_gateway ;;
  stop) stop_sidecar ;;
  restart) stop_sidecar; start_sidecar ;;
  status) status_sidecar ;;
  *) echo "usage: $0 {install|update|start|stop|restart|status|ensure-gateway}" >&2; exit 1 ;;
esac
