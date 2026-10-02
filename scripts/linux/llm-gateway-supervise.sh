#!/usr/bin/env bash
# Keep the LLM gateway running: restart it as soon as the node process exits.
# OpenCode sends every model request through this gateway, so a dead gateway
# shows up in chat as "Cannot connect to API".
set -uo pipefail

GATEWAY_SCRIPT="$1"
OUT_LOG="$2"
ERR_LOG="$3"
MAX_LOG_BYTES=$((20 * 1024 * 1024))

child=""
stopping=0
on_stop() {
  stopping=1
  [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null
}
trap on_stop TERM INT

rotate() {
  local file="$1" size
  size="$(stat -c %s "$file" 2>/dev/null || echo 0)"
  if (( size > MAX_LOG_BYTES )); then
    mv -f "$file" "$file.1"
  fi
}

fast_exits=0
while (( ! stopping )); do
  rotate "$OUT_LOG"
  rotate "$ERR_LOG"
  started=$(date +%s)
  node --dns-result-order=ipv4first "$GATEWAY_SCRIPT" >>"$OUT_LOG" 2>>"$ERR_LOG" &
  child=$!
  wait "$child"
  code=$?
  child=""
  (( stopping )) && break
  echo "[llm-gateway-supervise] $(date -Is) gateway exited with code $code; restarting" >>"$ERR_LOG"
  if (( $(date +%s) - started < 10 )); then
    fast_exits=$((fast_exits + 1))
  else
    fast_exits=0
  fi
  # Crash loop (bad config, port taken): back off up to 30 s instead of spinning.
  delay=$(( fast_exits > 5 ? 30 : 1 + fast_exits * 2 ))
  sleep "$delay" &
  wait $!
done
