#!/usr/bin/env bash
# Explicit opt-in: downloads pinned upstream SDK binaries and builds our adapter.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ESOPT_NATIVE_HOME:-$ROOT/upstream-linux}"
[[ "$(uname -s)" == Linux ]] || { echo 'This installer requires Linux' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'ESOPT upstream SDK requires Linux x86_64' >&2; exit 1; }
if LC_ALL=C grep -q '[^ -~]' <<< "$DEST"; then echo 'ESOPT SDK needs an ASCII installation path' >&2; exit 1; fi
for tool in python3 curl cmake gcc g++; do command -v "$tool" >/dev/null; done
mkdir -p "$DEST/downloads" "$DEST/deps/include/nlohmann" "$DEST/deps/src" "$DEST/bin"
fetch() {
  local url="$1" file="$2" hash="$3"
  if [[ ! -f "$file" ]]; then curl --fail --location --retry 3 "$url" --output "$file.tmp"; mv "$file.tmp" "$file"; fi
  echo "$hash  $file" | sha256sum --check -
}
fetch https://raw.githubusercontent.com/yuntaoju2022/smart-energy-system/38d7df0e679d93da848e05f30327a4f2a56dc60b/esopt-install-linux.tar.gz "$DEST/downloads/esopt-install-linux.tar.gz" f19eebd9a9be971445581ed7bdc51d3ad752657ce1bfdfc8f29610b582ee6a03
fetch https://codeload.github.com/ERGO-Code/HiGHS/tar.gz/refs/tags/v1.12.0 "$DEST/downloads/highs-1.12.0.tar.gz" cd0daddaca57e66b55524588d715dc62dcee06b5ab9ad186412dc23bc71ae342
fetch https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp "$DEST/deps/include/nlohmann/json.hpp" aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63
# Reject archive traversal and links before extraction; never run upstream scripts.
python3 - "$DEST" <<'PY'
import sys, tarfile
from pathlib import Path
base = Path(sys.argv[1]).resolve()
for filename, target in [('esopt-install-linux.tar.gz', base), ('highs-1.12.0.tar.gz', base / 'deps/src')]:
    with tarfile.open(base / 'downloads' / filename) as archive:
        for member in archive.getmembers():
            path = (target / member.name).resolve()
            if not path.is_relative_to(target) or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe archive entry: ' + member.name)
        archive.extractall(target)
PY
cmake -S "$DEST/deps/src/HiGHS-1.12.0" -B "$DEST/deps/highs-gcc-build" \
  -DCMAKE_C_COMPILER="$(command -v gcc)" -DCMAKE_CXX_COMPILER="$(command -v g++)" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DBUILD_TESTING=OFF \
  -DCMAKE_INSTALL_PREFIX="$DEST/deps/highs"
cmake --build "$DEST/deps/highs-gcc-build" -j"${ESOPT_BUILD_JOBS:-4}"
cmake --install "$DEST/deps/highs-gcc-build"
g++ -std=c++20 -O2 -I"$DEST/esopt-install/include/esopt" -I"$DEST/deps/include" \
  "$ROOT/native/esopt_native.cpp" -L"$DEST/esopt-install/lib" \
  -Wl,-rpath,'$ORIGIN/../esopt-install/lib' -lesopt -o "$DEST/bin/esopt-native.new"
mv "$DEST/bin/esopt-native.new" "$DEST/bin/esopt-native"
echo "Installed ESOPT Linux adapter at $DEST; run tools/esopt/esopt.sh capabilities to probe it."
