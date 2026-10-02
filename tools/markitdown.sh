#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/markitdown-venv/bin/python"
REQ="$ROOT/markitdown/requirements.txt"
if [[ ! -x "$PY" ]]; then
  echo "[markitdown] creating venv $ROOT/markitdown-venv" >&2
  python3 -m venv "$ROOT/markitdown-venv"
  "$PY" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r "$REQ" \
    || "$PY" -m pip install -r "$REQ"
fi
exec "$PY" -m markitdown "$@"
