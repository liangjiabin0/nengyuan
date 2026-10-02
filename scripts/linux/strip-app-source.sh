#!/usr/bin/env bash
# Remove application TypeScript from the live intranet tree after the runtime
# bundle and Next production build are in place. Runtime assets stay.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "$PROJECT_ROOT" != "/data/ai4es" ]]; then
  echo "Refusing to strip source outside /data/ai4es (got $PROJECT_ROOT)." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_ROOT/dist/runtime/api.mjs" || ! -f "$PROJECT_ROOT/dist/runtime/worker.mjs" ]]; then
  echo "Missing dist/runtime process bundles." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_ROOT/.next/BUILD_ID" ]]; then
  echo "Missing .next/BUILD_ID. Run npm run build before stripping source." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_ROOT/src/lib/datav-logistics-config.json" ]]; then
  echo "Runtime data file src/lib/datav-logistics-config.json is missing." >&2
  exit 1
fi

echo "[strip] removing application TypeScript..."
find "$PROJECT_ROOT/src" -type f ! -name 'datav-logistics-config.json' -delete
find "$PROJECT_ROOT/src" -depth -type d -empty -delete
rm -rf "$PROJECT_ROOT/server"
if [[ -d "$PROJECT_ROOT/scripts" ]]; then
  find "$PROJECT_ROOT/scripts" -type f -name '*.ts' -delete
fi

echo "[strip] removing build cache, source maps, and git history..."
rm -rf "$PROJECT_ROOT/.next/cache" "$PROJECT_ROOT/.next/types" "$PROJECT_ROOT/.next/dev" "$PROJECT_ROOT/.git"
find "$PROJECT_ROOT/.next" -type f -name '*.map' -delete
rm -f "$PROJECT_ROOT"/tsconfig*.json "$PROJECT_ROOT"/next-env.d.ts "$PROJECT_ROOT"/*.tsbuildinfo

if [[ -e "$PROJECT_ROOT/server" || -f "$PROJECT_ROOT/src/lib/load-env.ts" ]]; then
  echo "Application source is still present." >&2
  exit 1
fi

echo "[strip] application source removed. Runtime bundle, .next, tools, and data remain."
