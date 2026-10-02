#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

sudo_cmd() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"
  elif [[ -n "${SUDO_PASS:-}" ]]; then
    printf '%s\n' "$SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo "$@"
  fi
}

if command -v omc >/dev/null 2>&1; then
  echo "[openmodelica] omc already present: $(command -v omc)"
  omc --version || true
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
CODENAME="${VERSION_CODENAME:-jammy}"

echo "[openmodelica] installing omc for $CODENAME"
sudo_cmd apt-get update -y
sudo_cmd apt-get install -y ca-certificates curl gnupg lsb-release

if curl -fsSL -m 60 https://build.openmodelica.org/apt/openmodelica.asc -o /tmp/openmodelica.asc; then
  sudo_cmd install -d /usr/share/keyrings
  sudo_cmd gpg --batch --yes --dearmor -o /usr/share/keyrings/openmodelica-keyring.gpg /tmp/openmodelica.asc
  sudo_cmd bash -c "echo 'deb [signed-by=/usr/share/keyrings/openmodelica-keyring.gpg] https://build.openmodelica.org/apt ${CODENAME} stable' > /etc/apt/sources.list.d/openmodelica.list"
  echo "[openmodelica] repo added, updating apt"
  sudo_cmd apt-get update -y
  if sudo_cmd apt-get install -y omc omlibrary || sudo_cmd apt-get install -y omc; then
    echo "[openmodelica] installed $(command -v omc)"
    omc --version || true
    exit 0
  fi
else
  echo "[openmodelica] could not download OpenModelica apt key"
fi

if sudo_cmd apt-get install -y openmodelica 2>/dev/null; then
  echo "[openmodelica] installed distro openmodelica"
  command -v omc && omc --version || true
  exit 0
fi

echo "[openmodelica] apt install failed. If Docker is available, build tools/openmodelica-gateway and map host port 18088."
exit 1
