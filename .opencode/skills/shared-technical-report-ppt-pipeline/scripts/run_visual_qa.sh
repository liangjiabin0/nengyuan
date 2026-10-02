#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: run_visual_qa.sh FINAL_PPTX OUTPUT_DIR" >&2
  exit 2
fi

final_pptx="$(realpath "$1")"
output_dir="$(realpath -m "$2")"
presentations_skill_dir="${PRESENTATIONS_SKILL_DIR:-/root/.codex/skills/builtins/presentations}"
export RUNTIME_NODE="${RUNTIME_NODE:-${CODEX_PRIMARY_RUNTIME_NODE:?CODEX_PRIMARY_RUNTIME_NODE is required}}"
export RUNTIME_NODE_MODULES="${RUNTIME_NODE_MODULES:-${CODEX_PRIMARY_RUNTIME_NODE_MODULES:?CODEX_PRIMARY_RUNTIME_NODE_MODULES is required}}"
export RUNTIME_BIN_DIR="${RUNTIME_BIN_DIR:-${CODEX_PRIMARY_RUNTIME_ROOT:?CODEX_PRIMARY_RUNTIME_ROOT is required}/dependencies/bin/override}"
export PATH="$RUNTIME_BIN_DIR:$PATH"

mkdir -p "$output_dir"
qa_pptx="$output_dir/final.pptx"
cp "$final_pptx" "$qa_pptx"

python3 "$presentations_skill_dir/container_tools/render_slides.py" "$qa_pptx"
python3 "$presentations_skill_dir/container_tools/create_montage.py" \
  --input_dir "$output_dir/final" \
  --output_file "$output_dir/contact-sheet.png" \
  --label_mode filename
python3 "$presentations_skill_dir/container_tools/slides_test.py" "$qa_pptx" \
  > "$output_dir/overflow-check.txt"

echo "$output_dir"
