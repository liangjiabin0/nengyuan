#!/usr/bin/env bash
set -euo pipefail

# Run on the GPU server as user. Uses sudo for packages, postgres, dirs, firewall.

PROJECT_ROOT="${1:-/data/ai4es}"
SUDO_PASS="${2:-}"

sudo_cmd() {
  if sudo -n true 2>/dev/null; then
    sudo "$@"
  elif [[ -n "$SUDO_PASS" ]]; then
    printf '%s\n' "$SUDO_PASS" | sudo -S -p '' "$@"
  else
    sudo "$@"
  fi
}

echo "[bootstrap] creating $PROJECT_ROOT"
sudo_cmd mkdir -p "$PROJECT_ROOT" /data/ai4es-pgdata
sudo_cmd chown -R "$(id -un):$(id -gn)" "$PROJECT_ROOT" /data/ai4es-pgdata || true

export DEBIAN_FRONTEND=noninteractive
echo "[bootstrap] apt packages"
sudo_cmd apt-get update -y
sudo_cmd apt-get install -y \
  build-essential python3-venv python3-pip curl ca-certificates \
  ripgrep poppler-utils mupdf-tools tmux rsync unzip tar \
  libpq-dev pkg-config libreoffice-impress ffmpeg fonts-noto-cjk

# PostgreSQL 16 via PGDG if possible, else docker, else distro postgres.
if ! command -v psql >/dev/null 2>&1; then
  if curl -fsS -m 15 https://www.postgresql.org/media/keys/ACCC4CF8.asc >/tmp/pgdg.asc 2>/dev/null; then
    sudo_cmd install -d /usr/share/postgresql-common/pgdg
    sudo_cmd cp /tmp/pgdg.asc /tmp/ACCC4CF8.asc
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo_cmd gpg --dearmor -o /usr/share/keyrings/postgresql.gpg || true
    echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt jammy-pgdg main" | sudo_cmd tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    sudo_cmd apt-get update -y || true
    sudo_cmd apt-get install -y postgresql-16 postgresql-client-16 || sudo_cmd apt-get install -y postgresql postgresql-contrib
  else
    sudo_cmd apt-get install -y postgresql postgresql-contrib
  fi
fi

sudo_cmd systemctl enable --now postgresql || sudo_cmd service postgresql start || true

# Existing credentials must never be changed by an installation script.
if ! sudo_cmd -u postgres psql -Atc "SELECT 1 FROM pg_roles WHERE rolname='ai4es'" | grep -qx 1; then
  AI4ES_DB_PASSWORD="${AI4ES_DB_PASSWORD:-}"
  export AI4ES_DB_PASSWORD
  if [[ ${#AI4ES_DB_PASSWORD} -lt 12 ]]; then
    echo "Set AI4ES_DB_PASSWORD (at least 12 characters) for first-time database creation." >&2
    exit 1
  fi
  python3 - <<'PY' | sudo_cmd -u postgres psql -v ON_ERROR_STOP=1
import os
password = os.environ['AI4ES_DB_PASSWORD'].replace("'", "''")
print("CREATE ROLE ai4es LOGIN PASSWORD '" + password + "';")
PY
fi
sudo_cmd -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='ai4es'" | grep -qx 1 \
  || sudo_cmd -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ai4es OWNER ai4es;"

if command -v ufw >/dev/null 2>&1; then
  sudo_cmd ufw allow 3000/tcp || true
fi

sudo_cmd loginctl enable-linger "$(id -un)" || true
mkdir -p "$HOME/.config/systemd/user"
echo "[bootstrap] done"
