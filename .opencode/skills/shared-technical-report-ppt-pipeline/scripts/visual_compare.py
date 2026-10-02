#!/usr/bin/env python3
"""Align reference/candidate slide rasters and emit visual-difference evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def overlap(a: np.ndarray, b: np.ndarray, dx: int, dy: int) -> tuple[np.ndarray, np.ndarray]:
    height, width = a.shape[:2]
    ax0, ax1 = max(0, dx), min(width, width + dx)
    ay0, ay1 = max(0, dy), min(height, height + dy)
    bx0, bx1 = max(0, -dx), min(width, width - dx)
    by0, by1 = max(0, -dy), min(height, height - dy)
    return a[ay0:ay1, ax0:ax1], b[by0:by1, bx0:bx1]


def align(reference: np.ndarray, candidate: np.ndarray, max_shift: int) -> tuple[int, int]:
    ref_gray = reference.mean(axis=2)
    can_gray = candidate.mean(axis=2)
    scale = max(1, int(max(reference.shape[:2]) / 420))
    ref_small = ref_gray[::scale, ::scale]
    can_small = can_gray[::scale, ::scale]
    limit = max(0, int(round(max_shift / scale)))
    best = (float("inf"), 0, 0)
    for dy in range(-limit, limit + 1):
        for dx in range(-limit, limit + 1):
            a, b = overlap(ref_small, can_small, dx, dy)
            if a.size == 0:
                continue
            score = float(np.mean(np.abs(a - b)))
            if score < best[0]:
                best = (score, dx, dy)
    return best[1] * scale, best[2] * scale


def edge_mask(rgb: np.ndarray, threshold: float = 24.0) -> np.ndarray:
    gray = rgb.mean(axis=2)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:] = np.abs(gray[:, 1:] - gray[:, :-1])
    gy[1:, :] = np.abs(gray[1:, :] - gray[:-1, :])
    return np.maximum(gx, gy) >= threshold


def dilate(mask: np.ndarray) -> np.ndarray:
    result = mask.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            result |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return result


def edge_f1(reference: np.ndarray, candidate: np.ndarray) -> float:
    ref = edge_mask(reference)
    can = edge_mask(candidate)
    matched_ref = ref & dilate(can)
    matched_can = can & dilate(ref)
    recall = matched_ref.sum() / max(1, ref.sum())
    precision = matched_can.sum() / max(1, can.sum())
    return float(2 * precision * recall / max(1e-9, precision + recall))


def compare(reference_path: Path, candidate_path: Path, output_dir: Path, args: argparse.Namespace) -> dict:
    reference_image = Image.open(reference_path).convert("RGB")
    candidate_image = Image.open(candidate_path).convert("RGB")
    if candidate_image.size != reference_image.size:
        candidate_image = candidate_image.resize(reference_image.size, Image.Resampling.LANCZOS)
    reference = np.asarray(reference_image, dtype=np.float32)
    candidate = np.asarray(candidate_image, dtype=np.float32)
    dx, dy = align(reference, candidate, args.max_shift)
    ref_crop, can_crop = overlap(reference, candidate, dx, dy)
    delta = np.abs(ref_crop - can_crop)
    mae = float(delta.mean() / 255.0)
    rmse = float(np.sqrt(np.mean((ref_crop - can_crop) ** 2)) / 255.0)
    mismatch = float((delta.max(axis=2) >= args.pixel_delta).mean())
    f1 = edge_f1(ref_crop, can_crop)

    height, width = ref_crop.shape[:2]
    regions = []
    for row in range(args.grid_rows):
        for col in range(args.grid_cols):
            y0, y1 = row * height // args.grid_rows, (row + 1) * height // args.grid_rows
            x0, x1 = col * width // args.grid_cols, (col + 1) * width // args.grid_cols
            value = float(delta[y0:y1, x0:x1].mean() / 255.0)
            regions.append({"row": row, "column": col, "mae": round(value, 6)})
    worst = sorted(regions, key=lambda item: -item["mae"])[:5]
    passed = mae <= args.max_mae and mismatch <= args.max_mismatch and f1 >= args.min_edge_f1
    record = {
        "schemaVersion": "slide-visual-comparison.v1",
        "reference": str(reference_path.resolve()),
        "candidate": str(candidate_path.resolve()),
        "referenceSize": reference_image.size,
        "candidateResizedToReference": candidate_image.size,
        "alignment": {"candidateDxPx": dx, "candidateDyPx": dy},
        "metrics": {
            "normalizedMAE": round(mae, 6),
            "normalizedRMSE": round(rmse, 6),
            "mismatchRatio": round(mismatch, 6),
            "edgeF1": round(f1, 6),
        },
        "thresholds": {
            "maxMAE": args.max_mae,
            "maxMismatchRatio": args.max_mismatch,
            "minEdgeF1": args.min_edge_f1,
            "pixelDelta": args.pixel_delta,
        },
        "worstGridRegions": worst,
        "passed": passed,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = candidate_path.stem
    full_delta = np.abs(reference - candidate).mean(axis=2) / 255.0
    heat = np.zeros((*full_delta.shape, 3), dtype=np.uint8)
    heat[..., 0] = np.clip(full_delta * 700, 0, 255).astype(np.uint8)
    heat[..., 1] = np.clip((1 - full_delta) * 80, 0, 80).astype(np.uint8)
    overlay = (np.asarray(reference_image, dtype=np.float32) * 0.5 + np.asarray(candidate_image, dtype=np.float32) * 0.5).astype(np.uint8)
    Image.fromarray(heat).save(output_dir / f"{stem}.diff.png")
    Image.fromarray(overlay).save(output_dir / f"{stem}.overlay.png")
    (output_dir / f"{stem}.comparison.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--max-shift", type=int, default=10)
    parser.add_argument("--pixel-delta", type=float, default=18.0)
    parser.add_argument("--max-mae", type=float, default=0.12)
    parser.add_argument("--max-mismatch", type=float, default=0.34)
    parser.add_argument("--min-edge-f1", type=float, default=0.62)
    parser.add_argument("--grid-cols", type=int, default=6)
    parser.add_argument("--grid-rows", type=int, default=4)
    args = parser.parse_args()
    record = compare(args.reference.resolve(), args.candidate.resolve(), args.output_dir.resolve(), args)
    print(json.dumps(record["metrics"], ensure_ascii=False))
    if not record["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
