#!/usr/bin/env python3
"""Validate measured layout maps without requiring jsonschema."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


TOP_REQUIRED = {
    "slide_index", "title", "subtitle", "section", "canvas_width_px",
    "canvas_height_px", "slide_width_in", "slide_height_in", "elements",
}
ELEMENT_REQUIRED = {
    "id", "type", "text", "x", "y", "w", "h", "font", "font_size", "bold",
    "italic", "color", "fill", "line", "radius", "align", "vertical_align",
    "z_order", "editable", "asset_source", "reproduction_strategy",
}


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    errors = []
    missing = sorted(TOP_REQUIRED - data.keys())
    if missing:
        errors.append(f"missing top-level fields: {', '.join(missing)}")
        return errors
    width, height = data["canvas_width_px"], data["canvas_height_px"]
    if not finite_number(width) or width <= 0 or not finite_number(height) or height <= 0:
        errors.append("canvas dimensions must be positive finite numbers")
        return errors
    if not isinstance(data["elements"], list):
        errors.append("elements must be a list")
        return errors
    ids = set()
    z_orders = set()
    for index, element in enumerate(data["elements"]):
        prefix = f"element[{index}]"
        if not isinstance(element, dict):
            errors.append(f"{prefix} must be an object")
            continue
        missing = sorted(ELEMENT_REQUIRED - element.keys())
        if missing:
            errors.append(f"{prefix} missing fields: {', '.join(missing)}")
            continue
        if element["id"] in ids:
            errors.append(f"{prefix} duplicate id: {element['id']}")
        ids.add(element["id"])
        if element["z_order"] in z_orders:
            errors.append(f"{prefix} duplicate z_order: {element['z_order']}")
        z_orders.add(element["z_order"])
        for key in ("x", "y", "w", "h", "font_size", "radius"):
            if not finite_number(element[key]) or element[key] < 0:
                errors.append(f"{prefix}.{key} must be a nonnegative finite number")
        if finite_number(element["x"]) and finite_number(element["w"]) and element["x"] + element["w"] > width + 0.5:
            errors.append(f"{prefix} exceeds canvas width")
        if finite_number(element["y"]) and finite_number(element["h"]) and element["y"] + element["h"] > height + 0.5:
            errors.append(f"{prefix} exceeds canvas height")
        if not isinstance(element["editable"], bool):
            errors.append(f"{prefix}.editable must be boolean")
        if element["type"] == "icon" and not element["asset_source"]:
            errors.append(f"{prefix} icon requires asset_source provenance")
        if element["type"] in {"text", "title", "subtitle", "page-number"} and not element["editable"]:
            errors.append(f"{prefix} narrative text must be editable")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("layout_maps", nargs="+", type=Path)
    args = parser.parse_args()
    failures = {}
    for path in args.layout_maps:
        errors = validate(path.resolve())
        if errors:
            failures[str(path.resolve())] = errors
    if failures:
        print(json.dumps(failures, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    print(f"PASS: {len(args.layout_maps)} layout map(s)")


if __name__ == "__main__":
    main()
