#!/usr/bin/env python3
"""Run visual comparison for a complete ordered reference/candidate slide set."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw

import visual_compare


def natural_key(path: Path) -> list[object]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", path.name)]


def image_files(directory: Path) -> list[Path]:
    allowed = {".png", ".jpg", ".jpeg", ".webp"}
    return sorted((path for path in directory.iterdir() if path.suffix.casefold() in allowed), key=natural_key)


def contact_sheet(pairs: list[tuple[Path, Path, Path]], output: Path) -> None:
    cell_w, cell_h, label_h, gap = 360, 203, 26, 12
    canvas = Image.new("RGB", (cell_w * 3 + gap * 4, (cell_h + label_h + gap) * len(pairs) + gap), "white")
    draw = ImageDraw.Draw(canvas)
    labels = ("Reference", "Candidate", "Difference")
    for row, triple in enumerate(pairs):
        y = gap + row * (cell_h + label_h + gap)
        for col, path in enumerate(triple):
            x = gap + col * (cell_w + gap)
            image = Image.open(path).convert("RGB")
            image.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
            px = x + (cell_w - image.width) // 2
            py = y + label_h + (cell_h - image.height) // 2
            canvas.paste(image, (px, py))
            draw.text((x + 4, y + 4), f"{row + 1:02d} {labels[col]}", fill="black")
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference_dir", type=Path)
    parser.add_argument("candidate_dir", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--max-shift", type=int, default=10)
    parser.add_argument("--pixel-delta", type=float, default=18.0)
    parser.add_argument("--max-mae", type=float, default=0.12)
    parser.add_argument("--max-mismatch", type=float, default=0.34)
    parser.add_argument("--min-edge-f1", type=float, default=0.62)
    parser.add_argument("--grid-cols", type=int, default=6)
    parser.add_argument("--grid-rows", type=int, default=4)
    args = parser.parse_args()
    references = image_files(args.reference_dir.resolve())
    candidates = image_files(args.candidate_dir.resolve())
    if len(references) != len(candidates):
        raise SystemExit(f"slide-count mismatch: {len(references)} references, {len(candidates)} candidates")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    records = []
    sheet_pairs = []
    for index, (reference, candidate) in enumerate(zip(references, candidates), start=1):
        slide_dir = output_dir / f"slide-{index:02d}"
        record = visual_compare.compare(reference, candidate, slide_dir, args)
        record["slide"] = index
        records.append(record)
        sheet_pairs.append((reference, candidate, slide_dir / f"{candidate.stem}.diff.png"))
    summary = {
        "schemaVersion": "replication-qa.v1",
        "slideCount": len(records),
        "passed": all(record["passed"] for record in records),
        "failedSlides": [record["slide"] for record in records if not record["passed"]],
        "meanMAE": sum(record["metrics"]["normalizedMAE"] for record in records) / max(1, len(records)),
        "meanEdgeF1": sum(record["metrics"]["edgeF1"] for record in records) / max(1, len(records)),
        "slides": records,
    }
    (output_dir / "replication-qa.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    contact_sheet(sheet_pairs, output_dir / "comparison-contact-sheet.png")
    print(output_dir / "replication-qa.json")
    if not summary["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
