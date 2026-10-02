import hashlib
from pathlib import Path
from typing import Any

import yaml


def load_replacements(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    data: Any = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    replacements = data.get("replacements", {}) if isinstance(data, dict) else {}
    if not isinstance(replacements, dict):
        raise ValueError("replacements 必须是映射")
    return {str(key): str(value) for key, value in replacements.items()}


def apply_replacements(text: str, replacements: dict[str, str]) -> str:
    result = text
    for source in sorted(replacements, key=lambda item: (-len(item), item)):
        result = result.replace(source, replacements[source])
    return result


def dictionary_hash(path: Path) -> str:
    content = path.read_bytes() if path.exists() else b""
    return hashlib.sha256(content).hexdigest()
