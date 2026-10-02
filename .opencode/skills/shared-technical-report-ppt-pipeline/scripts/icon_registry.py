#!/usr/bin/env python3
"""Resolve, recolor, and validate icons against the local electrical allowlist."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
ROOT = SKILL_DIR / "assets" / "electrical-icons"


def norm(value: str) -> str:
    return re.sub(r"[\s_\-/]+", "", value.casefold())


def load() -> tuple[dict, dict]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "lock.json").read_text(encoding="utf-8"))
    return manifest, lock


def resolve(query: str, manifest: dict) -> list[dict]:
    q = norm(query)
    scored: dict[str, tuple[int, list[str]]] = {}
    for keyword, icons in manifest["keywordMap"].items():
        key = norm(keyword)
        if q == key:
            base_score = 100
        elif q in key or key in q:
            base_score = 70 - abs(len(q) - len(key))
        else:
            continue
        for rank, icon in enumerate(icons):
            score = base_score - rank
            if icon not in scored or score > scored[icon][0]:
                scored[icon] = (score, [keyword])
            elif score == scored[icon][0]:
                scored[icon][1].append(keyword)
    for icon in manifest["allowedIcons"]:
        name = norm(icon)
        if q == name:
            scored[icon] = (120, [icon])
        elif q and q in name:
            prior = scored.get(icon, (0, []))
            scored[icon] = (max(60, prior[0]), prior[1] + [icon])
    return [
        {"icon": icon, "score": score, "matched": sorted(set(keys))}
        for icon, (score, keys) in sorted(scored.items(), key=lambda item: (-item[1][0], item[0]))
    ]


def validate(icon: str, lock: dict) -> Path:
    if icon not in lock["icons"]:
        raise ValueError(f"icon is not allowlisted: {icon}")
    path = ROOT / lock["icons"][icon]["file"]
    if not path.is_file():
        raise FileNotFoundError(f"missing local icon: {path}; run sync_icon_library.py")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != lock["icons"][icon]["sha256"]:
        raise ValueError(f"icon hash mismatch: {icon}")
    return path


def normalize_color(value: str) -> str:
    color = value.strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ValueError("color must be #RRGGBB")
    return color.upper()


def export_icon(source: Path, target: Path, color: str | None, stroke_width: float | None) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if color is None and stroke_width is None:
        shutil.copyfile(source, target)
        return
    text = source.read_text(encoding="utf-8")
    if color:
        text = text.replace("currentColor", normalize_color(color))
    if stroke_width is not None:
        if not 0.5 <= stroke_width <= 4:
            raise ValueError("stroke width must be between 0.5 and 4")
        text = re.sub(r'stroke-width="[^"]+"', f'stroke-width="{stroke_width:g}"', text)
    target.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("query", nargs="?")
    parser.add_argument("--top", type=int, default=5)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--copy", type=Path)
    parser.add_argument("--color")
    parser.add_argument("--stroke-width", type=float)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    manifest, lock = load()

    if args.list:
        result = [{"icon": name, "path": str(validate(name, lock))} for name in manifest["allowedIcons"]]
    elif args.query:
        result = resolve(args.query, manifest)[: max(1, args.top)]
        if not result:
            print(f"No allowlisted icon matches {args.query!r}", file=sys.stderr)
            raise SystemExit(2)
        for item in result:
            item["path"] = str(validate(item["icon"], lock))
    else:
        parser.error("provide a query or --list")

    if args.copy:
        if not args.query:
            parser.error("--copy requires a query")
        source = Path(result[0]["path"])
        export_icon(source, args.copy.resolve(), args.color, args.stroke_width)
        result[0]["exported"] = str(args.copy.resolve())

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in result:
            print(f"{item['icon']}\t{item['path']}")


if __name__ == "__main__":
    main()
