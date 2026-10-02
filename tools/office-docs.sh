#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/office-docs-venv/bin/python"
if [[ -x "$PY" ]]; then
  exec "$PY" "$ROOT/office-docs/run.py" "$@"
fi
exec python3 "$ROOT/office-docs/run.py" "$@"
