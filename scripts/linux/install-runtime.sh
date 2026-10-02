#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"
ai4es_load_env "$PROJECT_ROOT"

BOOTSTRAP_PYTHON="${AI4ES_BOOTSTRAP_PYTHON:-}"
if [[ -z "$BOOTSTRAP_PYTHON" ]]; then
  if [[ -x /home/user/miniforge3/bin/python ]]; then
    BOOTSTRAP_PYTHON=/home/user/miniforge3/bin/python
  else
    BOOTSTRAP_PYTHON="$(command -v python3)"
  fi
fi
PIP_INDEX="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"

ensure_venv() {
  local name="$1" req="$2"
  local venv="$PROJECT_ROOT/tools/$name"
  local py="$venv/bin/python"
  if [[ ! -x "$py" ]]; then
    echo "[portable] creating tools/$name"
    "$BOOTSTRAP_PYTHON" -m venv "$venv"
  fi
  "$py" -m pip install -U pip
  if [[ -f "$req" ]]; then
    "$py" -m pip install --disable-pip-version-check -i "$PIP_INDEX" -r "$req" \
      || "$py" -m pip install --disable-pip-version-check -r "$req"
  fi
}

chmod +x "$PROJECT_ROOT/scripts/esopt-mcp.sh" \
  "$PROJECT_ROOT/scripts/linux/"*.sh \
  "$PROJECT_ROOT/tools/"*.sh \
  "$PROJECT_ROOT/tools/ppt-voice/ppt-voice.sh" 2>/dev/null || true

if [[ "${SKIP_NPM:-0}" != 1 ]]; then
  echo "[portable] npm ci"
  npm ci
fi

mkdir -p "$PROJECT_ROOT/tools/opencode" "$PROJECT_ROOT/tools/ripgrep" "$PROJECT_ROOT/storage" "$PROJECT_ROOT/数据"
ai4es_ensure_empty_corpus "$PROJECT_ROOT"
if ! command -v mutool >/dev/null 2>&1; then
  echo "[portable] WARNING: mutool missing. Install mupdf-tools (CAJ conversion)." >&2
fi
if ! command -v pdftoppm >/dev/null 2>&1; then
  echo "[portable] WARNING: pdftoppm missing. Install poppler-utils." >&2
fi
if [[ ! -x "$PROJECT_ROOT/tools/ripgrep/rg" ]] && command -v rg >/dev/null 2>&1; then
  ln -sfn "$(command -v rg)" "$PROJECT_ROOT/tools/ripgrep/rg"
fi
if [[ ! -x "$PROJECT_ROOT/tools/opencode/opencode" ]]; then
  echo "[portable] WARNING: tools/opencode/opencode is missing. Copy the linux-x64 binary there."
fi

if [[ "${SKIP_PYTHON:-0}" != 1 ]]; then
  ensure_venv esopt-venv "$PROJECT_ROOT/tools/esopt/requirements.txt"
  ensure_venv tdmg-venv "$PROJECT_ROOT/tools/tdmg-acopf-dispatch/requirements.txt"
  ensure_venv pdf2md-venv "$PROJECT_ROOT/tools/pdf2md/requirements.txt"
  ensure_venv caj2pdf-venv "$PROJECT_ROOT/tools/caj2pdf-fresh/caj2pdf-master/requirements.txt"
  ensure_venv power-dispatch-venv "$PROJECT_ROOT/tools/power-dispatch/requirements-full.txt"
  ensure_venv nwxs-loss-venv "$PROJECT_ROOT/tools/nwxs-loss/requirements.txt"
  ensure_venv forecast-venv "$PROJECT_ROOT/tools/pv-wind-load-forecast/requirements.txt"
  ensure_venv office-docs-venv "$PROJECT_ROOT/tools/office-docs/requirements.txt"
  ensure_venv markitdown-venv "$PROJECT_ROOT/tools/markitdown/requirements.txt"
  ensure_venv openmodelica-gateway-venv "$PROJECT_ROOT/tools/openmodelica-gateway/requirements.txt"
  ensure_venv mgplan-venv "$PROJECT_ROOT/tools/mgplan/requirements.txt"
  # pywin32 is Windows-only
  local_ppt_req="$(mktemp)"
  grep -v -i pywin32 "$PROJECT_ROOT/tools/ppt-voice/requirements.txt" >"$local_ppt_req" || true
  ensure_venv ppt-voice-venv "$local_ppt_req"
  rm -f "$local_ppt_req"
  "$BOOTSTRAP_PYTHON" "$PROJECT_ROOT/tools/office-docs/run.py" --ensure || true
fi

# render.py needs LibreOffice for page previews of generated Word/PPT/Excel files,
# and CJK fonts so Chinese text does not render as boxes.
if ! command -v soffice >/dev/null 2>&1 && ! command -v libreoffice >/dev/null 2>&1 \
  && [[ ! -x "$PROJECT_ROOT/tools/libreoffice/program/soffice" ]]; then
  echo "[portable] WARNING: LibreOffice not found; document page previews are disabled." >&2
  echo "[portable]   install: sudo apt-get install -y libreoffice-writer libreoffice-impress libreoffice-calc fonts-noto-cjk" >&2
  echo "[portable]   or:      sudo dnf install -y libreoffice-writer libreoffice-impress libreoffice-calc google-noto-sans-cjk-fonts" >&2
fi

echo "[portable] project-local runtime is ready."
