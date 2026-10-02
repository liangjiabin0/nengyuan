#!/usr/bin/env python3
"""Audit restrained-green preview colors outside declared source-image regions."""

from __future__ import annotations

import argparse
import colorsys
import json
from pathlib import Path

from PIL import Image


def parse_box(value: str) -> tuple[float, float, float, float]:
    parts = [float(item) for item in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("box must be x,y,w,h in normalized coordinates")
    x, y, w, h = parts
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
        raise argparse.ArgumentTypeError("box must stay inside the normalized canvas")
    return x, y, w, h


def inside_box(x: float, y: float, boxes: list[tuple[float, float, float, float]]) -> bool:
    return any(bx <= x <= bx + bw and by <= y <= by + bh for bx, by, bw, bh in boxes)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ignore-box", action="append", default=[], type=parse_box)
    parser.add_argument("--green-hue-min", type=float, default=135.0)
    parser.add_argument("--green-hue-max", type=float, default=195.0)
    parser.add_argument("--max-off-palette-ratio", type=float, default=0.025)
    parser.add_argument("--max-red-page-ratio", type=float, default=0.03)
    parser.add_argument("--max-hue-families", type=int, default=3)
    parser.add_argument("--sample-step", type=int, default=3)
    args = parser.parse_args()
    report = {"images": [], "errors": []}
    for path in args.images:
        image = Image.open(path).convert("RGB")
        width, height = image.size
        total = green = red = other = neutral = 0
        hue_bins: dict[int, int] = {}
        for py in range(0, height, max(1, args.sample_step)):
            ny = py / height
            for px in range(0, width, max(1, args.sample_step)):
                nx = px / width
                if inside_box(nx, ny, args.ignore_box):
                    continue
                r, g, b = image.getpixel((px, py))
                h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                total += 1
                hue = h * 360
                if s < 0.12 or v < 0.16 or v > 0.985:
                    neutral += 1
                    continue
                hue_bins[int(hue // 24)] = hue_bins.get(int(hue // 24), 0) + 1
                if args.green_hue_min <= hue <= args.green_hue_max:
                    green += 1
                elif hue <= 15 or hue >= 345:
                    red += 1
                else:
                    other += 1
        denom = max(1, total)
        off_ratio = other / denom
        red_ratio = red / denom
        material_hue_families = sum(1 for count in hue_bins.values() if count / denom >= 0.005)
        row = {
            "file": str(path.resolve()),
            "sampledPixels": total,
            "neutralRatio": round(neutral / denom, 5),
            "greenRatio": round(green / denom, 5),
            "redRatio": round(red_ratio, 5),
            "offPaletteRatio": round(off_ratio, 5),
            "materialHueFamilies": material_hue_families,
            "errors": [],
        }
        if off_ratio > args.max_off_palette_ratio:
            row["errors"].append(
                f"off-palette chromatic ratio {off_ratio:.4f} exceeds {args.max_off_palette_ratio:.4f}"
            )
        if red_ratio > args.max_red_page_ratio:
            row["errors"].append(
                f"red ratio {red_ratio:.4f} exceeds {args.max_red_page_ratio:.4f}"
            )
        if material_hue_families > args.max_hue_families:
            row["errors"].append(
                f"material hue families {material_hue_families} exceed {args.max_hue_families}"
            )
        report["images"].append(row)
        report["errors"].extend(f"{path.name}: {error}" for error in row["errors"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(args.output.resolve())
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
