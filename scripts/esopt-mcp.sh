#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AI4ES_PROJECT_ROOT="${AI4ES_PROJECT_ROOT:-$ROOT}"
export ESOPT_ROOT="${ESOPT_ROOT:-$ROOT/tools/esopt}"
export ESOPT_BRIDGE="${ESOPT_BRIDGE:-$ESOPT_ROOT/esopt_bridge}"
export ESOPT_NATIVE_ROOT="${ESOPT_NATIVE_ROOT:-$ESOPT_ROOT}"
if [[ -z "${ESOPT_PYTHON:-}" ]]; then
  if [[ -x "$ROOT/tools/esopt-venv/bin/python" ]]; then
    ESOPT_PYTHON="$ROOT/tools/esopt-venv/bin/python"
  else
    ESOPT_PYTHON="$(command -v python3 || command -v python)"
  fi
fi
export ESOPT_PYTHON
if [[ ! -d "$ESOPT_BRIDGE/esopt_agent" ]]; then
  echo "ESOPT MCP bridge not found: $ESOPT_BRIDGE" >&2
  exit 1
fi
export PYTHONPATH="$ESOPT_BRIDGE${PYTHONPATH:+:$PYTHONPATH}"
cd "$ESOPT_BRIDGE"
exec "$ESOPT_PYTHON" -u -m esopt_agent mcp
