#!/usr/bin/env python3
"""Read-only PPTX structural preflight for ratio, placeholders, formulas, and leaks."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "a14": "http://schemas.microsoft.com/office/drawing/2010/main",
}
RAW_FORMULA = re.compile(r"\\[A-Za-z]+|[A-Za-zα-ωΑ-Ω]\s*[_^]\s*(?:\{|[A-Za-z0-9])")


def text_of(node: ET.Element) -> str:
    return "".join((item.text or "") for item in node.findall(".//a:t", NS)).strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--expected-ratio",
        default="16:9",
        help="expected ratio such as 16:9 or 4:3; use auto to skip ratio enforcement",
    )
    parser.add_argument(
        "--math-font",
        default="Cambria Math",
        help="required serialized font evidence when native Office Math exists",
    )
    args = parser.parse_args()
    pptx = args.pptx.resolve()
    report = {
        "file": str(pptx),
        "slideCount": 0,
        "slideSize": {},
        "officeMathCount": 0,
        "mathFont": args.math_font,
        "mathFontEvidence": 0,
        "emptyPlaceholders": [],
        "rawFormulaMarkup": [],
        "errors": [],
        "warnings": [],
    }

    if not pptx.is_file():
        raise SystemExit(f"file not found: {pptx}")

    with zipfile.ZipFile(pptx) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        cx = int(size.attrib["cx"])
        cy = int(size.attrib["cy"])
        ratio = cx / cy
        report["slideSize"] = {"cx": cx, "cy": cy, "ratio": ratio}
        if args.expected_ratio.casefold() != "auto":
            if ":" in args.expected_ratio:
                left, right = args.expected_ratio.split(":", 1)
                expected_ratio = float(left) / float(right)
            else:
                expected_ratio = float(args.expected_ratio)
            report["slideSize"]["expectedRatio"] = expected_ratio
            if abs(ratio - expected_ratio) > 0.002:
                report["errors"].append(
                    f"slide ratio is {ratio:.6f}, expected {args.expected_ratio}"
                )

        slide_names = sorted(
            (
                name
                for name in archive.namelist()
                if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
            ),
            key=lambda name: int(re.search(r"slide(\d+)\.xml$", name).group(1)),
        )
        report["slideCount"] = len(slide_names)
        for slide_number, name in enumerate(slide_names, start=1):
            xml_bytes = archive.read(name)
            root = ET.fromstring(xml_bytes)
            report["officeMathCount"] += len(root.findall(".//m:oMath", NS))
            report["mathFontEvidence"] += xml_bytes.count(args.math_font.encode("utf-8"))
            for shape in root.findall(".//p:sp", NS):
                placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", NS)
                if placeholder is not None and not text_of(shape):
                    name_node = shape.find("./p:nvSpPr/p:cNvPr", NS)
                    report["emptyPlaceholders"].append(
                        {
                            "slide": slide_number,
                            "shape": name_node.attrib.get("name", "") if name_node is not None else "",
                            "type": placeholder.attrib.get("type", "body"),
                        }
                    )
            for item in root.findall(".//a:t", NS):
                value = item.text or ""
                if RAW_FORMULA.search(value):
                    report["rawFormulaMarkup"].append(
                        {"slide": slide_number, "text": value[:160]}
                    )

    if report["emptyPlaceholders"]:
        report["errors"].append(
            f"{len(report['emptyPlaceholders'])} empty inherited placeholder(s)"
        )
    if report["rawFormulaMarkup"]:
        report["errors"].append(
            f"{len(report['rawFormulaMarkup'])} visible raw formula-markup occurrence(s)"
        )
    if report["officeMathCount"] == 0:
        report["warnings"].append("no native Office Math objects detected")
    if report["officeMathCount"] > 0 and report["mathFontEvidence"] == 0:
        report["errors"].append(
            f"Office Math exists but no {args.math_font} font evidence was found"
        )

    output = args.output.resolve() if args.output else pptx.with_suffix(".preflight.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(output)
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
