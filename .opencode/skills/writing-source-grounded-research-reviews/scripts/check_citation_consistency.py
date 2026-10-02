#!/usr/bin/env python3
"""Check sequential bracketed citations against a report's reference list."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Sequence

try:
    from scripts.extract_reference_list import ENTRY_START_RE, REFERENCE_HEADING_RE, read_document_text
except ModuleNotFoundError:  # direct script execution from scripts/
    from extract_reference_list import ENTRY_START_RE, REFERENCE_HEADING_RE, read_document_text

CITATION_RE = re.compile(r"[\[［]([0-9０-９\s,，;；\-–—]+)[\]］]")


def _to_ascii_digits(value: str) -> str:
    return value.translate(str.maketrans("０１２３４５６７８９", "0123456789"))


def expand_citation_content(content: str) -> list[int]:
    """Expand '1,3-5，8' into ordered unique numbers."""
    normalized = _to_ascii_digits(content).replace("，", ",").replace("；", ",").replace(";", ",")
    normalized = normalized.replace("–", "-").replace("—", "-")
    result: list[int] = []
    for token in normalized.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            pieces = [p.strip() for p in token.split("-", 1)]
            if len(pieces) != 2 or not all(p.isdigit() for p in pieces):
                continue
            start, end = map(int, pieces)
            if start <= end:
                result.extend(range(start, end + 1))
            else:
                result.extend(range(end, start + 1))
        elif token.isdigit():
            result.append(int(token))
    return list(dict.fromkeys(result))


def _split_body_and_references(text: str) -> tuple[str, str]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    heading_indices = [i for i, line in enumerate(lines) if REFERENCE_HEADING_RE.match(line.strip())]
    if heading_indices:
        i = heading_indices[-1]
        return "\n".join(lines[:i]), "\n".join(lines[i + 1 :])
    return text, ""


def _reference_numbers(reference_text: str) -> list[int]:
    numbers: list[int] = []
    for line in reference_text.splitlines():
        match = ENTRY_START_RE.match(line.strip())
        if match:
            numbers.append(int(match.group("bracket") or match.group("plain")))
    return numbers


def analyze_citations(source: str | Path) -> dict:
    """Return machine-readable citation/reference consistency diagnostics."""
    if isinstance(source, Path) or (isinstance(source, str) and Path(source).exists()):
        text = read_document_text(source)
    else:
        text = str(source)

    body, reference_text = _split_body_and_references(text)
    cited_occurrences: list[int] = []
    raw_citations: list[str] = []
    for match in CITATION_RE.finditer(body):
        raw_citations.append(match.group(0))
        cited_occurrences.extend(expand_citation_content(match.group(1)))

    reference_numbers = _reference_numbers(reference_text)
    cited = sorted(set(cited_occurrences))
    refs = sorted(set(reference_numbers))
    duplicate_refs = sorted(number for number, count in Counter(reference_numbers).items() if count > 1)
    missing_refs = sorted(set(cited) - set(refs))
    unused_refs = sorted(set(refs) - set(cited))
    expected = set(range(1, max(refs) + 1)) if refs else set()
    non_sequential = sorted(expected - set(refs))

    return {
        "cited_numbers": cited,
        "reference_numbers": refs,
        "missing_reference_numbers": missing_refs,
        "unused_reference_numbers": unused_refs,
        "duplicate_reference_numbers": duplicate_refs,
        "non_sequential_reference_numbers": non_sequential,
        "citation_occurrence_count": len(raw_citations),
        "raw_citations": raw_citations,
        "ok": not (missing_refs or duplicate_refs or non_sequential),
    }


def _format_text(report: dict) -> str:
    lines = [
        f"Cited numbers: {report['cited_numbers']}",
        f"Reference numbers: {report['reference_numbers']}",
        f"Missing references: {report['missing_reference_numbers']}",
        f"Unused references: {report['unused_reference_numbers']}",
        f"Duplicate reference numbers: {report['duplicate_reference_numbers']}",
        f"Non-sequential reference numbers: {report['non_sequential_reference_numbers']}",
        f"Citation occurrences: {report['citation_occurrence_count']}",
        f"Status: {'PASS' if report['ok'] else 'CHECK REQUIRED'}",
    ]
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="DOCX/TXT/MD report")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--output", type=Path, help="Optional output file")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = analyze_citations(args.input)
    output = json.dumps(report, ensure_ascii=False, indent=2) if args.format == "json" else _format_text(report)
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
