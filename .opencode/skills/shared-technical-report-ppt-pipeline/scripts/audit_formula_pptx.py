#!/usr/bin/env python3
"""Audit native Office Math in a PPTX against a formula manifest."""

from __future__ import annotations

import argparse
import difflib
import json
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
}
STRUCTURES = {
    "fraction": "f", "radical": "rad", "subscript": "sSub",
    "superscript": "sSup", "subsup": "sSubSup", "nary": "nary",
    "matrix": "m", "delimiter": "d", "equation-array": "eqArr",
}
CHAR_EQUIVALENTS = str.maketrans({
    "−": "-", "–": "-", "—": "-", "﹣": "-",
    "⋅": "*", "·": "*", "×": "*", "∗": "*",
    "＝": "=", "，": ",", "（": "(", "）": ")",
})


def canonical(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).translate(CHAR_EQUIVALENTS)
    value = re.sub(r"[\\_^{}]", "", value)
    return re.sub(r"\s+", "", value)


def slide_number(name: str) -> int:
    return int(re.search(r"slide(\d+)\.xml$", name).group(1))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--similarity", type=float, default=0.98)
    args = parser.parse_args()
    equations = json.loads(args.manifest.read_text(encoding="utf-8")).get("equations", [])
    report = {"pptx": str(args.pptx.resolve()), "manifest": str(args.manifest.resolve()), "equations": [], "errors": [], "warnings": []}
    with zipfile.ZipFile(args.pptx) as archive:
        slide_names = sorted(
            (n for n in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=slide_number,
        )
        roots = {slide_number(n): (ET.fromstring(archive.read(n)), archive.read(n)) for n in slide_names}
        for entry in equations:
            eq_id = entry["id"]
            slide = entry["slide"]
            row = {"id": eq_id, "slide": slide, "errors": [], "warnings": []}
            if slide not in roots:
                row["errors"].append("slide not found")
            else:
                root, raw = roots[slide]
                math_nodes = root.findall(".//m:oMath", NS)
                math_texts = ["".join((t.text or "") for t in node.findall(".//m:t", NS)) for node in math_nodes]
                normalized = [canonical(value) for value in math_texts]
                expected = canonical(entry["canonical"])
                scores = [difflib.SequenceMatcher(None, expected, value).ratio() for value in normalized]
                best = max(scores, default=0.0)
                row.update({"officeMathCountOnSlide": len(math_nodes), "mathText": math_texts, "bestCanonicalSimilarity": round(best, 4)})
                if not math_nodes:
                    row["errors"].append("no native Office Math object on slide")
                elif expected and best < args.similarity:
                    row["errors"].append(f"canonical equation similarity {best:.4f} is below {args.similarity:.4f}")
                joined = canonical(" ".join(math_texts))
                for token in entry.get("requiredTokens", []):
                    if canonical(token) not in joined:
                        row["errors"].append(f"missing required token: {token}")
                visible = "".join((t.text or "") for t in root.findall(".//a:t", NS)) + " ".join(math_texts)
                number = entry.get("equationNumber", "")
                if number and canonical(number) not in canonical(visible):
                    row["errors"].append(f"missing equation number: {number}")
                for structure in entry.get("requiredStructures", []):
                    local = STRUCTURES[structure]
                    if not root.findall(f".//m:{local}", NS):
                        row["errors"].append(f"missing Office Math structure: {structure}")
                math_font = entry.get("mathFont", "Cambria Math")
                if math_font.encode("utf-8") not in raw:
                    row["warnings"].append(f"no serialized {math_font} font evidence on slide")
            report["equations"].append(row)
            report["errors"].extend(f"{eq_id}: {error}" for error in row["errors"])
            report["warnings"].extend(f"{eq_id}: {warning}" for warning in row["warnings"])
    output = args.output or args.pptx.with_suffix(".formula-audit.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(output.resolve())
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
