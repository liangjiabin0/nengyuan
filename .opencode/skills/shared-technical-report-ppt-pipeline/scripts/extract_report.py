#!/usr/bin/env python3
"""Extract a DOCX technical report to Markdown, media, and a navigable source index."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
HTML_IMAGE_RE = re.compile(r"<img\s+[^>]*src=[\"']([^\"']+)[\"'][^>]*>", re.I)
CAPTION_RE = re.compile(r"^(?:图|Figure|Fig\.?|表|Table)\s*([\d.\-]+)?\s*(.*)$", re.I)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_docx(source: Path, out_dir: Path) -> Path:
    if shutil.which("pandoc") is None:
        raise SystemExit("pandoc is required to extract DOCX sources")
    markdown = out_dir / "report.md"
    media_dir = out_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "pandoc",
            str(source),
            "--from=docx",
            "--to=gfm+tex_math_dollars",
            "--wrap=none",
            f"--extract-media={out_dir}",
            "--output",
            str(markdown),
        ],
        check=True,
    )
    return markdown


def build_index(source: Path, markdown: Path, out_dir: Path) -> dict:
    lines = markdown.read_text(encoding="utf-8").splitlines()
    headings = []
    figures = []
    tables = []
    equations = []
    current_section = ""
    in_display_math = False
    equation_start = 0
    equation_lines: list[str] = []
    table_start = None
    table_lines: list[str] = []

    for index, line in enumerate(lines, start=1):
        heading = HEADING_RE.match(line)
        if heading:
            current_section = heading.group(2).strip()
            headings.append(
                {"level": len(heading.group(1)), "title": current_section, "line": index}
            )

        image = IMAGE_RE.search(line)
        html_image = HTML_IMAGE_RE.search(line)
        if image or html_image:
            caption = image.group(1).strip() if image else ""
            image_path = image.group(2) if image else html_image.group(1)
            if not caption:
                for candidate in lines[index : min(index + 3, len(lines))]:
                    match = CAPTION_RE.match(candidate.strip())
                    if match:
                        caption = candidate.strip()
                        break
            figures.append(
                {
                    "line": index,
                    "section": current_section,
                    "caption": caption,
                    "path": image_path,
                }
            )

        stripped = line.strip()
        if stripped == "$$":
            if not in_display_math:
                in_display_math = True
                equation_start = index
                equation_lines = []
            else:
                equations.append(
                    {
                        "lineStart": equation_start,
                        "lineEnd": index,
                        "section": current_section,
                        "source": "\n".join(equation_lines).strip(),
                    }
                )
                in_display_math = False
                equation_lines = []
            continue
        if in_display_math:
            equation_lines.append(line)
        else:
            for match in re.finditer(r"\$\$(.+?)\$\$", line):
                equations.append(
                    {
                        "lineStart": index,
                        "lineEnd": index,
                        "section": current_section,
                        "source": match.group(1).strip(),
                    }
                )

        is_table_line = stripped.startswith("|") and stripped.endswith("|")
        if is_table_line:
            if table_start is None:
                table_start = index
                table_lines = []
            table_lines.append(line)
        elif table_start is not None:
            if len(table_lines) >= 2:
                tables.append(
                    {
                        "lineStart": table_start,
                        "lineEnd": index - 1,
                        "section": current_section,
                        "preview": table_lines[:4],
                    }
                )
            table_start = None
            table_lines = []

    if table_start is not None and len(table_lines) >= 2:
        tables.append(
            {
                "lineStart": table_start,
                "lineEnd": len(lines),
                "section": current_section,
                "preview": table_lines[:4],
            }
        )

    media_files = []
    for path in sorted(out_dir.rglob("*")):
        if path.is_file() and path != markdown and path.name != "source-index.json":
            media_files.append(
                {
                    "path": str(path.relative_to(out_dir)),
                    "bytes": path.stat().st_size,
                    "sha256": sha256(path),
                }
            )

    return {
        "sourceFile": source.name,
        "sourcePath": str(source),
        "sourceSha256": sha256(source),
        "markdown": str(markdown),
        "lineCount": len(lines),
        "headings": headings,
        "figures": figures,
        "tables": tables,
        "equations": equations,
        "media": media_files,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    out_dir = args.output_dir.resolve()
    if not source.is_file():
        raise SystemExit(f"source file not found: {source}")
    if source.suffix.lower() != ".docx":
        raise SystemExit("extract_report.py currently accepts DOCX; use the PDF skill for PDF")

    out_dir.mkdir(parents=True, exist_ok=True)
    markdown = extract_docx(source, out_dir)
    index = build_index(source, markdown, out_dir)
    index_path = out_dir / "source-index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(index_path)


if __name__ == "__main__":
    main()
