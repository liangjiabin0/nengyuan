from __future__ import annotations

import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def _default_data_dir() -> Path:
    here = Path(__file__).resolve().parents[1] / "data"
    try:
        str(here).encode("ascii")
        return here
    except UnicodeEncodeError:
        local = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or "."
        return Path(local) / "om-gateway-data"


DATA_DIR = Path(os.environ.get("OMG_DATA_DIR") or _default_data_dir())
API_KEY = os.environ.get("OMG_API_KEY") or "change-me"
MAX_WORKERS = _int("OMG_MAX_WORKERS", 2)
MAX_CODE_BYTES = _int("OMG_MAX_CODE_BYTES", 1_000_000)
MAX_RESULT_POINTS = _int("OMG_MAX_RESULT_POINTS", 5000)
JOB_TTL_SECONDS = _int("OMG_JOB_TTL_SECONDS", 86400)
MODELICA_VERSION = os.environ.get("OMG_MODELICA_VERSION") or "4.1.0"
HOST = os.environ.get("OMG_HOST") or "0.0.0.0"
PORT = _int("OMG_PORT", 18088)
