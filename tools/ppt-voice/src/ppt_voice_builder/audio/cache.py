import hashlib
import json
import os
from pathlib import Path
from typing import Any


def build_cache_key(**values: Any) -> str:
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class AudioCache:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, cache_key: str) -> Path:
        if len(cache_key) != 64 or any(c not in "0123456789abcdef" for c in cache_key):
            raise ValueError("cache_key 必须是 SHA-256 十六进制摘要")
        return self.root / cache_key[:2] / f"{cache_key}.mp3"

    def lookup(self, cache_key: str) -> Path | None:
        path = self.path_for(cache_key)
        return path if path.is_file() else None

    def staging_path(self, cache_key: str) -> Path:
        path = self.path_for(cache_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path.with_suffix(".mp3.download")

    def commit(self, cache_key: str, staged: Path) -> Path:
        destination = self.path_for(cache_key)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, destination)
        return destination
