from __future__ import annotations
import hashlib, json
from pathlib import Path


def canonical_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest_object(obj) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def package_root() -> Path:
    return Path(__file__).resolve().parents[2]
