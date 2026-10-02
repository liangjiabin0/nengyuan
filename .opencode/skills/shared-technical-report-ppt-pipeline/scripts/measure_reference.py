#!/usr/bin/env python3
"""Measure reference-slide rasters and emit deterministic geometry guides."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def smooth(values: np.ndarray, width: int) -> np.ndarray:
    width = max(1, int(width))
    if width == 1:
        return values
    kernel = np.ones(width, dtype=np.float32) / width
    return np.convolve(values, kernel, mode="same")


def peak_groups(values: np.ndarray, limit: int = 36) -> list[dict]:
    if not len(values):
        return []
    threshold = float(max(np.quantile(values, 0.88), values.mean() + values.std() * 0.65))
    indices = np.flatnonzero(values >= threshold)
    groups: list[list[int]] = []
    for index in indices.tolist():
        if not groups or index - groups[-1][-1] > 3:
            groups.append([index])
        else:
            groups[-1].append(index)
    peaks = []
    for group in groups:
        local = max(group, key=lambda index: float(values[index]))
        peaks.append({"pixel": int(local), "strength": round(float(values[local]), 3)})
    return sorted(peaks, key=lambda item: -item["strength"])[:limit]


def dominant_colors(image: Image.Image, count: int = 12) -> list[dict]:
    sample = image.convert("RGB")
    sample.thumbnail((320, 320), Image.Resampling.LANCZOS)
    quantized = sample.quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()
    result = []
    for pixels, index in sorted(quantized.getcolors() or [], reverse=True):
        rgb = tuple(palette[index * 3 : index * 3 + 3])
        result.append({"hex": "#%02X%02X%02X" % rgb, "pixels": int(pixels)})
    return result


def slide_size(width: int, height: int) -> tuple[float, float, str]:
    ratio = width / height
    if abs(ratio - 16 / 9) <= 0.02:
        return 13.333333, 7.5, "16:9"
    if abs(ratio - 4 / 3) <= 0.02:
        return 10.0, 7.5, "4:3"
    return ratio * 7.5, 7.5, f"{ratio:.5f}:1"


def measure(path: Path, output_dir: Path) -> dict:
    image = Image.open(path).convert("RGB")
    width, height = image.size
    slide_width, slide_height, ratio_name = slide_size(width, height)
    rgb = np.asarray(image, dtype=np.float32)
    gray = rgb.mean(axis=2)
    vertical = np.abs(np.diff(gray, axis=1)).mean(axis=0)
    horizontal = np.abs(np.diff(gray, axis=0)).mean(axis=1)
    vertical = smooth(vertical, max(1, width // 500))
    horizontal = smooth(horizontal, max(1, height // 500))
    v_peaks = peak_groups(vertical)
    h_peaks = peak_groups(horizontal)
    for item in v_peaks:
        item["normalized"] = round(item["pixel"] / width, 6)
        item["inches"] = round(item["pixel"] / width * slide_width, 5)
    for item in h_peaks:
        item["normalized"] = round(item["pixel"] / height, 6)
        item["inches"] = round(item["pixel"] / height * slide_height, 5)

    record = {
        "schemaVersion": "reference-measurement.v1",
        "source": str(path.resolve()),
        "canvas": {
            "widthPx": width,
            "heightPx": height,
            "ratio": width / height,
            "ratioName": ratio_name,
            "slideWidthIn": slide_width,
            "slideHeightIn": slide_height,
            "xInPerPx": slide_width / width,
            "yInPerPx": slide_height / height,
        },
        "dominantColors": dominant_colors(image),
        "candidateGuides": {"vertical": v_peaks, "horizontal": h_peaks},
        "elements": [],
        "measurementStatus": "machine-guides-generated; element boxes require visual/OCR classification",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = path.stem
    (output_dir / f"{stem}.measurement.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    guide = image.copy()
    draw = ImageDraw.Draw(guide, "RGBA")
    for item in v_peaks[:18]:
        x = item["pixel"]
        draw.line((x, 0, x, height), fill=(255, 0, 0, 105), width=max(1, width // 900))
    for item in h_peaks[:18]:
        y = item["pixel"]
        draw.line((0, y, width, y), fill=(0, 100, 255, 105), width=max(1, height // 700))
    guide.save(output_dir / f"{stem}.guides.png")
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    records = [measure(path.resolve(), args.output_dir.resolve()) for path in args.images]
    index = args.output_dir.resolve() / "measurement-index.json"
    index.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(index)


if __name__ == "__main__":
    main()
