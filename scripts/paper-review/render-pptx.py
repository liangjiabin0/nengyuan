"""Render the final PPTX with LibreOffice and Poppler for Linux review tasks."""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "tools" / "pptx" / "scripts"))
from office.render import to_pdf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pptx", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--width", type=int, default=1920)
    args = parser.parse_args()
    if not 320 <= args.width <= 7680:
        parser.error("width must be between 320 and 7680")
    source = Path(args.pptx).resolve(strict=True)
    output = Path(args.out_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    rasterizer = shutil.which("pdftoppm")
    if not rasterizer:
        raise RuntimeError("pdftoppm not found; install Poppler")
    pdf = output / "final.pdf"
    to_pdf(source, pdf, engine="soffice", timeout=180)
    if not pdf.exists() or pdf.stat().st_size == 0:
        raise RuntimeError("LibreOffice did not produce the PDF")
    subprocess.run(
        [rasterizer, "-png", "-scale-to-x", str(args.width), "-scale-to-y", "-1", str(pdf), str(output / "page")],
        check=True, timeout=90, capture_output=True,
    )
    pages = sorted(output.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
    if len(pages) != 2:
        raise RuntimeError(f"Expected exactly two slides, rendered {len(pages)}")
    files = []
    for index, page in enumerate(pages, 1):
        target = output / f"slide-{index:02d}.png"
        page.replace(target)
        files.append(str(target))
    print(json.dumps({"slides": len(files), "width": args.width, "files": files, "engine": "soffice"}))


if __name__ == "__main__":
    main()
