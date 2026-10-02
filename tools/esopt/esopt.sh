#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export ESOPT_ROOT="${ESOPT_ROOT:-$ROOT}"
export PYTHONPATH="$ROOT/esopt_bridge${PYTHONPATH:+:$PYTHONPATH}"
if [[ -x "$ROOT/../esopt-venv/bin/python" ]]; then
  PY="$ROOT/../esopt-venv/bin/python"
elif [[ -x "$ROOT/.venv/bin/python" ]]; then
  PY="$ROOT/.venv/bin/python"
else
  PY="${ESOPT_PYTHON:-python3}"
fi
exec "$PY" -m esopt_agent "$@"
