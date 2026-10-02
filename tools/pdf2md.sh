#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/pdf2md-venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "pdf2md venv missing: $PY" >&2
  exit 1
fi
exec "$PY" "$ROOT/pdf2md/pdf_to_md.py" "$@"
