"""Render the final PPTX with LibreOffice and Poppler for Linux review tasks."""
import argparse
import json
import posixpath
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "tools" / "pptx" / "scripts"))
from office.render import to_pdf


def renderable_copy(source, target):
    """Rasterize SVG fallback images in a temporary copy for LibreOffice."""
    relationship = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"
    drawing = "{http://schemas.openxmlformats.org/drawingml/2006/main}blip"
    svg_tag = "{http://schemas.microsoft.com/office/drawing/2016/SVG/main}svgBlip"
    replacements = {}
    with zipfile.ZipFile(source) as deck:
        names = set(deck.namelist())
        for slide in names:
            if not slide.startswith("ppt/slides/slide") or not slide.endswith(".xml"):
                continue
            rels = posixpath.join(posixpath.dirname(slide), "_rels", posixpath.basename(slide) + ".rels")
            if rels not in names:
                continue
            targets = {
                r.attrib["Id"]: posixpath.normpath(posixpath.join(posixpath.dirname(slide), r.attrib["Target"])).lstrip("/")
                for r in ElementTree.fromstring(deck.read(rels))
                if r.attrib.get("TargetMode") != "External"
            }
            for blip in ElementTree.fromstring(deck.read(slide)).iter(drawing):
                svg_blip = blip.find(".//" + svg_tag)
                if svg_blip is None:
                    continue
                fallback = targets.get(blip.attrib.get(relationship))
                svg = targets.get(svg_blip.attrib.get(relationship))
                if not fallback or not svg or not fallback.endswith(".png") or svg not in names:
                    continue
                if fallback in replacements:
                    continue
                result = subprocess.run(
                    ["node", "-e", "const fs=require('fs');require('sharp')(fs.readFileSync(0),{density:300}).resize({width:1920}).png().toBuffer().then(b=>process.stdout.write(b)).catch(e=>{console.error(e.message);process.exit(1)});"],
                    input=deck.read(svg), capture_output=True, check=True, timeout=30, cwd=root,
                )
                replacements[fallback] = result.stdout
        with zipfile.ZipFile(target, "w") as output:
            for info in deck.infolist():
                output.writestr(info, replacements.get(info.filename, deck.read(info.filename)))
    return len(replacements)


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
    with tempfile.TemporaryDirectory(prefix="review-ppt-render-") as scratch:
        compatible = Path(scratch) / "render.pptx"
        converted = renderable_copy(source, compatible)
        result = to_pdf(compatible, pdf, engine="soffice", timeout=180)
        if not result.get("ok"):
            raise RuntimeError("LibreOffice conversion failed: " + json.dumps(result))
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
    print(json.dumps({"slides": len(files), "width": args.width, "files": files, "engine": "soffice", "svgFallbacks": converted}))


if __name__ == "__main__":
    main()
