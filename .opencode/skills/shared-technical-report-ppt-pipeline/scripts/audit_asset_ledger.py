#!/usr/bin/env python3
"""Enforce controlled icon provenance in a task asset ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
ICON_ROOT = SKILL_DIR / "assets" / "electrical-icons"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("asset_ledger", type=Path)
    args = parser.parse_args()
    data = json.loads(args.asset_ledger.read_text(encoding="utf-8"))
    assets = data if isinstance(data, list) else data.get("assets", [])
    lock = json.loads((ICON_ROOT / "lock.json").read_text(encoding="utf-8"))
    errors = []
    checked = 0
    for index, asset in enumerate(assets):
        if asset.get("kind") != "icon":
            continue
        checked += 1
        source_type = asset.get("sourceType")
        if source_type == "allowlist":
            name = asset.get("iconName")
            if name not in lock["icons"]:
                errors.append(f"asset[{index}] icon is not allowlisted: {name!r}")
                continue
            path = ICON_ROOT / lock["icons"][name]["file"]
            if not path.is_file():
                errors.append(f"asset[{index}] missing allowlisted file: {path}")
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != lock["icons"][name]["sha256"]:
                errors.append(f"asset[{index}] allowlisted file hash mismatch: {name}")
        elif source_type in {"user", "template", "reference"}:
            if not asset.get("sourceLocation"):
                errors.append(f"asset[{index}] {source_type} icon lacks sourceLocation")
        else:
            errors.append(f"asset[{index}] forbidden icon sourceType: {source_type!r}")
    if errors:
        print(json.dumps({"errors": errors}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    print(f"PASS: {checked} icon asset(s) have permitted provenance")


if __name__ == "__main__":
    main()
