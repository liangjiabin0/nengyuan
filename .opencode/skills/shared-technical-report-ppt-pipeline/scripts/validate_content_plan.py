#!/usr/bin/env python3
"""Lightweight semantic validation for content-plan JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ALLOWED_LAYOUTS = {"cover", "technical-content", "case-analysis", "comparison", "formula-heavy"}
ALLOWED_SOURCE_SLIDES = {1, 2, 3}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("content_plan", type=Path)
    args = parser.parse_args()
    plan = json.loads(args.content_plan.read_text(encoding="utf-8"))
    errors: list[str] = []
    deck = plan.get("deck", {})
    slides = plan.get("slides", [])
    if deck.get("aspectRatio") != "16:9":
        errors.append("deck.aspectRatio must be 16:9")
    if not slides:
        errors.append("slides must not be empty")
    pages = [slide.get("page") for slide in slides]
    if len(pages) != len(set(pages)):
        errors.append("slide page numbers must be unique")
    for index, slide in enumerate(slides, start=1):
        label = f"slide[{index}]"
        for key in ["page", "title", "subtitle", "takeaway", "layout", "sourceSlide", "sourceRefs", "content", "visuals"]:
            if key not in slide or slide[key] in (None, "", []):
                errors.append(f"{label}.{key} is required")
        if slide.get("layout") not in ALLOWED_LAYOUTS:
            errors.append(f"{label}.layout is invalid")
        if slide.get("sourceSlide") not in ALLOWED_SOURCE_SLIDES:
            errors.append(f"{label}.sourceSlide must be 1, 2, or 3")
        if any(not str(ref).strip() for ref in slide.get("sourceRefs", [])):
            errors.append(f"{label}.sourceRefs contains an empty reference")
        formula_visual = any(v.get("type") == "formula" for v in slide.get("visuals", []))
        if formula_visual and not slide.get("formulaIds"):
            errors.append(f"{label} has formula visuals but no formulaIds")
        for visual_index, visual in enumerate(slide.get("visuals", []), start=1):
            if not visual.get("source") or not visual.get("purpose"):
                errors.append(f"{label}.visuals[{visual_index}] needs source and purpose")
    if errors:
        print("FAIL")
        for error in errors:
            print("- " + error)
        raise SystemExit(1)
    print(f"PASS: {len(slides)} planned slide(s)")


if __name__ == "__main__":
    main()

