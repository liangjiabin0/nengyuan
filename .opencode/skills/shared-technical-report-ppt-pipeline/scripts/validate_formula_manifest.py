#!/usr/bin/env python3
"""Validate the source-control fields needed for deterministic formula QA."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ALLOWED_STYLES = {"italic", "bold-italic", "upright"}
ALLOWED_STRUCTURES = {
    "fraction", "radical", "subscript", "superscript", "subsup", "nary",
    "matrix", "delimiter", "equation-array",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    data = json.loads(args.manifest.read_text(encoding="utf-8"))
    equations = data.get("equations")
    errors: list[str] = []
    if not isinstance(equations, list) or not equations:
        errors.append("equations must be a non-empty array")
        equations = []
    seen: set[str] = set()
    required = {
        "id", "slide", "source", "display", "canonical", "requiredTokens",
        "requiredStructures", "variables",
    }
    for index, item in enumerate(equations, start=1):
        label = item.get("id") or f"entry-{index}"
        missing = sorted(required - set(item))
        if missing:
            errors.append(f"{label}: missing {', '.join(missing)}")
        if label in seen:
            errors.append(f"{label}: duplicate id")
        seen.add(label)
        if not isinstance(item.get("slide"), int) or item.get("slide", 0) < 1:
            errors.append(f"{label}: slide must be a positive integer")
        for key in ("source", "display", "canonical"):
            if not isinstance(item.get(key), str) or not item.get(key, "").strip():
                errors.append(f"{label}: {key} must be non-empty")
        tokens = item.get("requiredTokens")
        if not isinstance(tokens, list) or not tokens or not all(isinstance(v, str) and v for v in tokens):
            errors.append(f"{label}: requiredTokens must be a non-empty string array")
        structures = item.get("requiredStructures")
        if not isinstance(structures, list):
            errors.append(f"{label}: requiredStructures must be an array")
        else:
            unknown = sorted(set(structures) - ALLOWED_STRUCTURES)
            if unknown:
                errors.append(f"{label}: unknown structures {', '.join(unknown)}")
        variables = item.get("variables")
        if not isinstance(variables, list):
            errors.append(f"{label}: variables must be an array")
        else:
            for var_index, variable in enumerate(variables, start=1):
                if not all(variable.get(k) for k in ("symbol", "role", "style")):
                    errors.append(f"{label}: variable {var_index} lacks symbol/role/style")
                elif variable["style"] not in ALLOWED_STYLES:
                    errors.append(f"{label}: variable {var_index} has invalid style")
        for crop_key in ("referenceCrop", "candidateCrop"):
            crop = item.get(crop_key)
            if crop is None:
                continue
            if not isinstance(crop, dict) or not all(k in crop for k in ("x", "y", "w", "h")):
                errors.append(f"{label}: {crop_key} must contain x/y/w/h")
                continue
            if any(not isinstance(crop[k], (int, float)) for k in ("x", "y", "w", "h")):
                errors.append(f"{label}: {crop_key} values must be numeric")
            elif crop["x"] < 0 or crop["y"] < 0 or crop["w"] <= 0 or crop["h"] <= 0 or crop["x"] + crop["w"] > 1 or crop["y"] + crop["h"] > 1:
                errors.append(f"{label}: {crop_key} must stay inside normalized canvas")
    if errors:
        print("FAIL")
        for error in errors:
            print("- " + error)
        raise SystemExit(1)
    print(f"PASS: {len(equations)} equation(s)")


if __name__ == "__main__":
    main()

