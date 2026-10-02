#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$ROOT/src:$ROOT${PYTHONPATH:+:$PYTHONPATH}"
VENV="$ROOT/../ppt-voice-venv/bin/python"
if [[ -n "${PPT_VOICE_PYTHON:-}" && -x "${PPT_VOICE_PYTHON}" ]]; then
  PY="$PPT_VOICE_PYTHON"
elif [[ -x "$VENV" ]]; then
  PY="$VENV"
else
  PY="$(command -v python3 || command -v python)"
fi
exec "$PY" -m ppt_voice_agent "$@"
