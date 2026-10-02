#!/usr/bin/env bash
# Build the Next.js production app and server bundles on the intranet host,
# then restart tmux session ai4es. On failure, restore the previous .next
# and start again without the new bundle.
set -euo pipefail

PROJECT_ROOT="/data/ai4es"
cd "$PROJECT_ROOT"
LOG="$PROJECT_ROOT/storage/runtime-publish.log"
mkdir -p "$PROJECT_ROOT/storage"
exec > >(tee -a "$LOG") 2>&1

stop_stack() {
  systemctl --user stop ai4es.service 2>/dev/null || true
  tmux kill-session -t ai4es 2>/dev/null || true
  pkill -KILL -f '/data/ai4es/scripts/linux/intranet-start.sh' 2>/dev/null || true
  sleep 1
  for port in 3000 4000 4097; do
    pid="$(ss -lptn "sport = :$port" 2>/dev/null | awk -Fpid= 'NR>1 {split($2,a,","); print a[1]; exit}')"
    if [[ -n "${pid:-}" ]]; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

echo "[publish] begin $(date -Is)"
stop_stack

if [[ -d "$PROJECT_ROOT/.next" ]]; then
  rm -rf "$PROJECT_ROOT/.next.prev"
  mv "$PROJECT_ROOT/.next" "$PROJECT_ROOT/.next.prev"
fi

restore_previous() {
  echo "[publish] restoring previous build"
  stop_stack
  rm -rf "$PROJECT_ROOT/.next" "$PROJECT_ROOT/dist/runtime"
  if [[ -d "$PROJECT_ROOT/.next.prev" ]]; then
    mv "$PROJECT_ROOT/.next.prev" "$PROJECT_ROOT/.next"
  fi
  systemctl --user start ai4es.service
}

echo "[publish] next build $(date -Is)"
if ! npm run build; then
  echo "[publish] BUILD_FAILED"
  restore_previous
  exit 1
fi

echo "[publish] bundle $(date -Is)"
if ! node scripts/bundle-server.mjs; then
  echo "[publish] BUNDLE_FAILED"
  restore_previous
  exit 1
fi

echo "[publish] start $(date -Is)"
systemctl --user start ai4es.service

ok=0
for _ in $(seq 1 180); do
  if curl -fsS -m 3 http://127.0.0.1:3000/healthz >/dev/null 2>&1 \
    && curl -fsS -m 3 http://127.0.0.1:4000/api/health >/dev/null 2>&1 \
    && pgrep -f 'dist/runtime/api.mjs' >/dev/null \
    && pgrep -f 'dist/runtime/worker.mjs' >/dev/null; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "$ok" != 1 ]]; then
  echo "[publish] HEALTH_FAILED"
  echo "---- intranet-start.log tail ----"
  tail -n 80 "$PROJECT_ROOT/storage/intranet-start.log" || true
  echo "---- api-server.err.log tail ----"
  tail -n 80 "$PROJECT_ROOT/storage/api-server.err.log" || true
  echo "---- web-server.err.log tail ----"
  tail -n 80 "$PROJECT_ROOT/storage/web-server.err.log" || true
  restore_previous
  exit 1
fi

rm -rf "$PROJECT_ROOT/.next.prev"
echo "[publish] HEALTHY $(date -Is)"
