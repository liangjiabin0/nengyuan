import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: compare_render_regions.py <before.png> <after.png> <allowed-rectangles.json>")
    before = Image.open(sys.argv[1]).convert("RGB")
    after = Image.open(sys.argv[2]).convert("RGB")
    if before.size != after.size:
        raise SystemExit(f"ERROR: image sizes differ: {before.size} vs {after.size}")
    rectangles = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    if not isinstance(rectangles, list):
        raise SystemExit("ERROR: rectangles JSON must be a list")
    difference = ImageChops.difference(before, after)
    allowed = Image.new("L", before.size, 0)
    draw = ImageDraw.Draw(allowed)
    for rect in rectangles:
        if not isinstance(rect, list) or len(rect) != 4:
            raise SystemExit("ERROR: every rectangle must be [left, top, right, bottom]")
        draw.rectangle(tuple(rect), fill=255)
    outside_mask = ImageChops.invert(allowed)
    outside = ImageChops.multiply(difference, Image.merge("RGB", (outside_mask, outside_mask, outside_mask)))
    if outside.getbbox() is not None:
        raise SystemExit(f"ERROR: pixels changed outside allowed rectangles: {outside.getbbox()}")
    print(f"PASS: changes are confined to {len(rectangles)} allowed rectangles; total diff bbox={difference.getbbox()}")


if __name__ == "__main__":
    main()
