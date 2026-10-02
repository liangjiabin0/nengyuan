"""
Answer "will Word open this file?" in one second, on any platform.

    python preflight.py report.docx
    python preflight.py unpacked/ --json

Checks, in the order they usually break a generated package:

- ZIP layer: every entry is readable and CRC-clean, ``[Content_Types].xml``
  exists. A reused ``ZipInfo`` from another archive shows up here as
  "Bad magic number for file header".
- XML layer: every ``.xml`` / ``.rels`` part parses.
- Namespaces: every prefix used by an element, an attribute or an
  ``mc:Ignorable`` token is declared. This is what Word reports as "the file
  appears to be corrupt" after an ElementTree round-trip renamed ``mc`` to
  ``ns1`` or dropped ``w14``.
- Content types: every part extension has a Default or an Override. A PNG
  added without ``<Default Extension="png"/>`` is the classic silent break.
- Relationships: every non-external Target exists in the package, and every
  ``r:id`` / ``r:embed`` referenced by a part is declared in that part's rels.
- Word body: ``word/document.xml`` has a ``w:body`` and a trailing sectPr.
- Drawings: no shape has a negative width or height (PowerPoint rejects the
  file; LibreOffice does not, so a LibreOffice preview hides it).

Exit 0 when clean (warnings allowed), 1 when Word would likely refuse the
file, 2 on usage errors. This is structural validation only; run
validate.py for full XSD checks and render.py to look at the layout.
"""

import argparse
import json
import re
import sys
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

CONTENT_TYPES = "[Content_Types].xml"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"

XML_SUFFIXES = (".xml", ".rels", ".vml")
_REL_ATTRS = {f"{{{R_NS}}}{name}" for name in ("id", "embed", "link", "dm", "lo", "qs", "cs", "pict")}
_AUTO_PREFIX_RE = re.compile(r"^ns\d+$")


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


class Report:
    def __init__(self, target: str):
        self.target = target
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.stats: dict = {}

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def payload(self) -> dict:
        return {
            "ok": not self.errors,
            "target": self.target,
            "errors": self.errors,
            "warnings": self.warnings,
            "stats": self.stats,
        }


def _read_package(target: Path, report: Report) -> dict[str, bytes] | None:
    if target.is_dir():
        parts = {}
        for path in sorted(p for p in target.rglob("*") if p.is_file()):
            parts[path.relative_to(target).as_posix()] = path.read_bytes()
        return parts
    try:
        with zipfile.ZipFile(target) as zf:
            try:
                broken = zf.testzip()
            except (zipfile.BadZipFile, OSError, zlib.error, EOFError) as exc:
                broken = None
                report.error(f"zip: the archive cannot be read through: {exc}")
            if broken:
                report.error(f"zip: CRC mismatch in {broken}")
            parts = {}
            for info in zf.infolist():
                if info.is_dir():
                    continue
                try:
                    parts[info.filename] = zf.read(info.filename)
                except (zipfile.BadZipFile, OSError, zlib.error, EOFError) as exc:
                    report.error(
                        f"zip: cannot read {info.filename}: {exc}. "
                        "Rebuild with package.py pack -- never reuse a ZipInfo from another archive."
                    )
            first = next((i.filename for i in zf.infolist() if not i.is_dir()), "")
            if first != CONTENT_TYPES:
                report.warn(f"zip: first entry is {first!r}; OPC readers expect {CONTENT_TYPES}")
        return parts
    except zipfile.BadZipFile as exc:
        report.error(f"zip: not a readable OOXML package: {exc}")
        return None


def _declared_namespaces(data: bytes) -> tuple[dict[str, str], ET.Element] | None:
    parser = ET.XMLPullParser(["start-ns", "start"])
    declared: dict[str, str] = {}
    root = None
    parser.feed(data)
    parser.close()
    for event, payload in parser.read_events():
        if event == "start-ns":
            prefix, uri = payload
            declared[prefix] = uri
        elif event == "start" and root is None:
            root = payload
    if root is None:
        return None
    return declared, root


def _check_namespaces(name: str, data: bytes, report: Report) -> None:
    try:
        parsed = _declared_namespaces(data)
    except ET.ParseError as exc:
        report.error(f"{name}: XML does not parse: {exc}")
        return
    if parsed is None:
        report.error(f"{name}: XML has no root element")
        return
    declared, root = parsed

    ignorable = root.get(_q(MC_NS, "Ignorable")) or ""
    undeclared = [token for token in ignorable.split() if token and token not in declared]
    if undeclared:
        report.error(
            f"{name}: mc:Ignorable names undeclared prefix(es) {' '.join(undeclared)}. "
            "Word refuses the file. Either declare the namespaces or drop them from mc:Ignorable."
        )

    auto = sorted(p for p in declared if p and _AUTO_PREFIX_RE.match(p))
    if auto:
        report.warn(
            f"{name}: auto-generated namespace prefix(es) {', '.join(auto)} -- an ElementTree "
            "round-trip lost the original prefixes; call package.register_ooxml_namespaces() first"
        )


def _check_content_types(parts: dict[str, bytes], report: Report) -> None:
    raw = parts.get(CONTENT_TYPES)
    if raw is None:
        report.error(f"package has no {CONTENT_TYPES}")
        return
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        report.error(f"{CONTENT_TYPES}: does not parse: {exc}")
        return
    # Word rejects the package when a tool appends an unprefixed <Override> to a
    # Types element that ElementTree re-serialized under an ns0: prefix, because
    # the new element lands in no namespace at all.
    stray = {
        child.tag.split("}")[-1] if "}" in child.tag else child.tag
        for child in root
        if not child.tag.startswith(f"{{{CT_NS}}}")
    }
    if stray:
        report.error(
            f"{CONTENT_TYPES}: {', '.join(sorted(stray))} element(s) are not in the content-types "
            "namespace. Word refuses the package. Rebuild the part with package.py, which keeps "
            "the namespace unprefixed, before any tool appends to it."
        )

    defaults = {(d.get("Extension") or "").lower() for d in root.findall(_q(CT_NS, "Default"))}
    overrides = {(o.get("PartName") or "").lstrip("/") for o in root.findall(_q(CT_NS, "Override"))}
    for name in parts:
        if name == CONTENT_TYPES or name.startswith("_rels/") or "/_rels/" in name:
            continue
        extension = Path(name).suffix.lstrip(".").lower()
        if name in overrides or extension in defaults:
            continue
        report.error(
            f"{CONTENT_TYPES}: no Default for .{extension} and no Override for {name}. "
            f"Add <Default Extension=\"{extension}\" .../> or Word will reject the package."
        )


def _resolve(base: str, target: str) -> str:
    target = target.replace("\\", "/")
    if target.startswith("/"):
        return target.lstrip("/")
    chunks: list[str] = []
    for chunk in (base + target).split("/"):
        if chunk in ("", "."):
            continue
        if chunk == "..":
            if chunks:
                chunks.pop()
            continue
        chunks.append(chunk)
    return "/".join(chunks)


def _referenced_rel_ids(data: bytes) -> set[str]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return set()
    found: set[str] = set()
    for element in root.iter():
        for key, value in element.attrib.items():
            if key in _REL_ATTRS and value:
                found.add(value)
    return found


def _check_relationships(parts: dict[str, bytes], report: Report) -> None:
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError as exc:
            report.error(f"{name}: does not parse: {exc}")
            continue
        base = "" if name == "_rels/.rels" else name.rsplit("_rels/", 1)[0]
        owner = "" if name == "_rels/.rels" else _resolve(base, name.rsplit("_rels/", 1)[1][: -len(".rels")])
        declared_ids = set()
        for rel in root.findall(_q(REL_NS, "Relationship")):
            rel_id = rel.get("Id") or ""
            if rel_id in declared_ids:
                report.error(f"{name}: duplicate relationship Id {rel_id}")
            declared_ids.add(rel_id)
            target = rel.get("Target") or ""
            if (rel.get("TargetMode") or "").lower() == "external" or "://" in target:
                continue
            resolved = _resolve(base, target)
            if resolved not in parts:
                report.error(f"{name}: {rel_id} targets {resolved}, which is not in the package")
        if owner and owner.endswith(XML_SUFFIXES) and owner in parts:
            for rel_id in sorted(_referenced_rel_ids(parts[owner]) - declared_ids):
                report.error(f"{owner}: uses relationship {rel_id}, which {name} does not declare")


def _check_word_body(parts: dict[str, bytes], report: Report) -> None:
    data = parts.get("word/document.xml")
    if data is None:
        return
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return
    body = root.find(_q(W_NS, "body"))
    if body is None:
        report.error("word/document.xml: no w:body element")
        return
    children = list(body)
    sect_prs = [child for child in children if child.tag == _q(W_NS, "sectPr")]
    if not sect_prs:
        report.warn("word/document.xml: w:body has no trailing w:sectPr; page setup falls back to defaults")
    elif len(sect_prs) > 1:
        report.error(
            f"word/document.xml: w:body has {len(sect_prs)} direct w:sectPr children. The schema allows "
            "exactly one, as the last child; the extras add empty sections. Keep only the final one."
        )
    elif children[-1].tag != _q(W_NS, "sectPr"):
        report.warn("word/document.xml: the final w:sectPr is not the last child of w:body")
    report.stats["paragraphs"] = sum(1 for _ in root.iter(_q(W_NS, "p")))
    report.stats["tables"] = sum(1 for _ in root.iter(_q(W_NS, "tbl")))
    report.stats["formulas"] = sum(
        1 for _ in root.iter("{http://schemas.openxmlformats.org/officeDocument/2006/math}oMath")
    )
    leaked = [
        pattern
        for pattern in ("**", "$$", "|---", "```")
        if any(pattern in (node.text or "") for node in root.iter(_q(W_NS, "t")))
    ]
    if leaked:
        report.warn(f"word/document.xml: Markdown-looking runs present ({', '.join(leaked)})")


A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_DRAWING_PARTS = re.compile(r"^(ppt/(slides|slideLayouts|slideMasters)/|word/|xl/drawings/)[^/]+\.xml$")


def _check_drawing_extents(parts: dict[str, bytes], report: Report) -> None:
    """Negative shape sizes: LibreOffice draws them, PowerPoint/Word call the file corrupt.

    pptxgenjs writes whatever w/h it is given, so a line drawn up or to the left
    with a negative h or w lands here. Draw it with positive w/h plus flipV/flipH.
    """
    bad: dict[str, list[str]] = {}
    for name, data in parts.items():
        if not _DRAWING_PARTS.match(name):
            continue
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            continue
        for ext in root.iter(_q(A_NS, "ext")):
            cx, cy = ext.get("cx"), ext.get("cy")
            if cx is None or cy is None:
                continue
            try:
                if int(cx) < 0 or int(cy) < 0:
                    bad.setdefault(name, []).append(f"cx={cx} cy={cy}")
            except ValueError:
                continue
    for name, sizes in bad.items():
        report.error(
            f"{name}: {len(sizes)} shape(s) with a negative width/height ({'; '.join(sizes[:3])}). "
            "PowerPoint and Word reject the whole file as corrupt although LibreOffice shows it. "
            "Give shapes positive w/h and use flipH/flipV for lines that run up or left."
        )


def preflight(target: Path) -> Report:
    report = Report(str(target))
    parts = _read_package(target, report)
    if parts is None:
        return report
    report.stats["parts"] = len(parts)
    for name, data in parts.items():
        if name.endswith(XML_SUFFIXES):
            _check_namespaces(name, data, report)
    _check_content_types(parts, report)
    _check_relationships(parts, report)
    _check_word_body(parts, report)
    _check_drawing_extents(parts, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Structural preflight for an OOXML package")
    parser.add_argument("target", help="Path to a .docx/.xlsx/.pptx or an unpacked directory")
    parser.add_argument("--json", action="store_true", help="Print the full JSON report")
    args = parser.parse_args()

    target = Path(args.target)
    if not target.exists():
        print(f"Error: {target} does not exist", file=sys.stderr)
        return 2

    report = preflight(target)
    payload = report.payload()
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(f"{'OK' if payload['ok'] else 'BROKEN'}  {target}")
        for line in report.errors:
            print(f"  error: {line}")
        for line in report.warnings:
            print(f"  warn:  {line}")
        if report.stats:
            print(f"  stats: {json.dumps(report.stats, ensure_ascii=False)}")
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
