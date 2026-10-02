#!/usr/bin/env python3
"""Audit a DOCX for the skill's academic formatting requirements.

This is an inspector, not an automatic formatter. It reports likely issues for
human review: script-specific fonts, non-black headings, grid tables,
non-superscript sequential citations, and native OMML equation counts.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Iterable, Sequence

from docx import Document
from docx.oxml.ns import qn

HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
LATIN_OR_NUMBER_RE = re.compile(r"[A-Za-z0-9]")
CITATION_RUN_RE = re.compile(r"^[\[［]\s*\d+(?:\s*[-–—,，]\s*\d+)*\s*[\]］]$")
ALLOWED_EAST_ASIA = {"宋体", "simsun"}
ALLOWED_LATIN = {"times new roman"}
BLACK_VALUES = {None, "000000", "auto", "AUTO"}


def _iter_paragraphs(parent) -> Iterable:
    for paragraph in getattr(parent, "paragraphs", []):
        yield paragraph
    for table in getattr(parent, "tables", []):
        for row in table.rows:
            for cell in row.cells:
                yield from _iter_paragraphs(cell)


def _rfonts_from_element(element) -> dict[str, str | None]:
    rpr = element.rPr
    rfonts = rpr.rFonts if rpr is not None else None
    if rfonts is None:
        return {"eastAsia": None, "ascii": None, "hAnsi": None, "cs": None}
    return {
        key: rfonts.get(qn(f"w:{key}"))
        for key in ("eastAsia", "ascii", "hAnsi", "cs")
    }


def _style_fonts(style) -> dict[str, str | None]:
    if style is None:
        return {"eastAsia": None, "ascii": None, "hAnsi": None, "cs": None}
    return _rfonts_from_element(style.element)


def _effective_fonts(run, paragraph) -> dict[str, str | None]:
    layers = [
        _rfonts_from_element(run._element),
        _style_fonts(getattr(run, "style", None)),
        _style_fonts(getattr(paragraph, "style", None)),
    ]
    result: dict[str, str | None] = {}
    for key in ("eastAsia", "ascii", "hAnsi", "cs"):
        result[key] = next((layer[key] for layer in layers if layer.get(key)), None)
    return result


def _heading_color(paragraph, run) -> str | None:
    color = run.font.color.rgb
    if color is not None:
        return str(color).upper()
    style = getattr(paragraph, "style", None)
    if style is not None and style.font.color.rgb is not None:
        return str(style.font.color.rgb).upper()
    return None


def _is_heading(paragraph) -> bool:
    style_name = (getattr(getattr(paragraph, "style", None), "name", "") or "").lower()
    return style_name.startswith("heading") or style_name.startswith("标题")


def _table_has_grid_borders(table) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    style_name = (getattr(getattr(table, "style", None), "name", "") or "").lower()
    if "grid" in style_name or "网格" in style_name:
        reasons.append(f"table_style={style_name}")

    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.find(qn("w:tblBorders")) if tbl_pr is not None else None
    if borders is not None:
        for edge in ("left", "right", "insideH", "insideV"):
            node = borders.find(qn(f"w:{edge}"))
            if node is not None:
                value = (node.get(qn("w:val")) or "").lower()
                if value not in {"", "nil", "none"}:
                    reasons.append(f"{edge}={value}")
    return bool(reasons), reasons


def _is_superscript(run) -> bool:
    if run.font.superscript is True:
        return True
    rpr = run._element.rPr
    if rpr is None:
        return False
    vert = rpr.find(qn("w:vertAlign"))
    return vert is not None and (vert.get(qn("w:val")) or "").lower() == "superscript"


def inspect_docx(path: str | Path) -> dict:
    file_path = Path(path)
    doc = Document(str(file_path))
    font_issues: list[dict] = []
    heading_issues: list[dict] = []
    citation_issues: list[dict] = []
    table_issues: list[dict] = []

    in_references = False
    paragraph_number = 0
    for paragraph in _iter_paragraphs(doc):
        paragraph_number += 1
        if paragraph.text.strip().lower() in {"参考文献", "references", "bibliography"}:
            in_references = True
        for run_number, run in enumerate(paragraph.runs, start=1):
            text = run.text
            if not text:
                continue
            fonts = _effective_fonts(run, paragraph)
            if HAN_RE.search(text):
                east_asia = (fonts.get("eastAsia") or "").lower()
                if east_asia not in ALLOWED_EAST_ASIA:
                    font_issues.append({
                        "paragraph": paragraph_number,
                        "run": run_number,
                        "kind": "east_asia_font",
                        "text": text[:80],
                        "actual": fonts.get("eastAsia"),
                        "expected": "宋体/SimSun",
                    })
            if LATIN_OR_NUMBER_RE.search(text):
                latin_values = [(fonts.get(key) or "").lower() for key in ("ascii", "hAnsi")]
                if not all(value in ALLOWED_LATIN for value in latin_values):
                    font_issues.append({
                        "paragraph": paragraph_number,
                        "run": run_number,
                        "kind": "latin_font",
                        "text": text[:80],
                        "actual": {"ascii": fonts.get("ascii"), "hAnsi": fonts.get("hAnsi")},
                        "expected": "Times New Roman",
                    })
            if _is_heading(paragraph):
                color = _heading_color(paragraph, run)
                if color not in BLACK_VALUES:
                    heading_issues.append({
                        "paragraph": paragraph_number,
                        "text": text[:80],
                        "color": color,
                    })
            if not in_references and CITATION_RUN_RE.match(text.strip()) and not _is_superscript(run):
                citation_issues.append({
                    "paragraph": paragraph_number,
                    "run": run_number,
                    "text": text,
                })

    for table_number, table in enumerate(doc.tables, start=1):
        has_issue, reasons = _table_has_grid_borders(table)
        if has_issue:
            table_issues.append({"table": table_number, "reasons": reasons})

    root = doc._element
    native_equations = root.xpath(".//m:oMath")
    native_equation_paragraphs = root.xpath(".//m:oMathPara")

    summary = {
        "font_issues": len(font_issues),
        "heading_color_issues": len(heading_issues),
        "table_issues": len(table_issues),
        "citation_superscript_issues": len(citation_issues),
        "native_equation_count": len(native_equations),
        "native_equation_paragraph_count": len(native_equation_paragraphs),
    }
    summary["ok"] = not any(
        summary[key]
        for key in ("font_issues", "heading_color_issues", "table_issues", "citation_superscript_issues")
    )

    return {
        "file": str(file_path),
        "summary": summary,
        "font_issues": font_issues,
        "heading_color_issues": heading_issues,
        "table_issues": table_issues,
        "citation_superscript_issues": citation_issues,
        "notes": [
            "The inspector cannot fully resolve theme inheritance or visually confirm every three-line table.",
            "Native equation count confirms OMML presence but does not validate mathematical semantics or italic/bold variable styling.",
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="DOCX file to inspect")
    parser.add_argument("--json", dest="json_path", type=Path, help="Write the audit to JSON")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = inspect_docx(args.input)
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.json_path:
        args.json_path.write_text(output, encoding="utf-8")
    else:
        print(output)
    return 0 if report["summary"]["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
