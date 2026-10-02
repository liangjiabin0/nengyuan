from __future__ import annotations
import json
from pathlib import Path
import yaml


def load_spec(path_or_obj):
    if isinstance(path_or_obj, dict):
        return path_or_obj
    path = Path(path_or_obj)
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("RunSpec root must be an object")
    data.setdefault("metadata", {})
    data["metadata"].setdefault("source_file", str(path))
    return data


def dump_json(path, obj):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
