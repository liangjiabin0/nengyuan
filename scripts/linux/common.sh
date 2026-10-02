#!/usr/bin/env bash
# Shared helpers for AI4ES Linux deploy/start scripts.

ai4es_project_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  cd "$here/../.." && pwd
}

ai4es_load_env() {
  local project_root="$1"
  local file line key value
  export AI4ES_PROJECT_ROOT="$project_root"
  # Match the Windows bootstrap: child processes always emit UTF-8, whatever the
  # container locale is, so tool output stays readable on both platforms.
  export PYTHONUTF8="${PYTHONUTF8:-1}"
  export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"
  for file in "$project_root/.env" "$project_root/.env.local"; do
    [[ -f "$file" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      key="${line%%=*}"
      value="${line#*=}"
      key="$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [[ -z "$key" ]] && continue
      if [[ -n "${!key+x}" ]]; then
        continue
      fi
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:-1}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:-1}"
      fi
      export "$key=$value"
    done < "$file"
  done
}

ai4es_wait_http() {
  local url="$1"
  local timeout_sec="${2:-90}"
  local elapsed=0
  while (( elapsed < timeout_sec )); do
    if curl -fsS -m 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

ai4es_listen_pid() {
  local port="$1"
  ss -lptn "sport = :$port" 2>/dev/null | awk -Fpid= 'NR>1 {split($2,a,","); print a[1]; exit}'
}

ai4es_ensure_empty_corpus() {
  local project_root="$1"
  local manifest="$project_root/storage/knowledge-corpus/MANIFEST.md"
  [[ -f "$manifest" ]] && return 0
  mkdir -p "$project_root/storage/knowledge-corpus"
  cat >"$manifest" <<EOF
---
record_key: corpus-manifest
kind: manifest
format: knowledge-corpus-markdown
version: 1
exported_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
database_path: ""
database_fingerprint: empty
total_records: 0
---

# Knowledge Corpus Manifest

空语料占位，只为让 OpenCode 能启动。导入资料并写入 PostgreSQL 后执行 \`npm run corpus:export\`，该命令会覆盖本文件。

## Record Counts

- **person:** 0
- **mentor:** 0
- **paper:** 0
- **patent:** 0
- **book:** 0
- **project:** 0
- **nkrd:** 0
- **output:** 0
EOF
  echo "[corpus] wrote empty manifest: $manifest"
}

ai4es_kill_port() {
  local port="$1"
  local pid
  pid="$(ai4es_listen_pid "$port" || true)"
  if [[ -n "${pid:-}" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$pid" 2>/dev/null || true
  fi
  fuser -k "${port}/tcp" 2>/dev/null || true
}
