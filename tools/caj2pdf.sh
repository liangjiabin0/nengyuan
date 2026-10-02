#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$ROOT:$PATH"
exec "$ROOT/caj2pdf-venv/bin/python" "$ROOT/caj2pdf-fresh/caj2pdf-master/caj2pdf" "$@"
