"""
Unpack / repack / patch an OOXML package (.docx, .xlsx, .pptx) identically on
Windows and Linux -- no unzip, no zip, no shell quoting.

    python package.py list     report.docx
    python package.py unpack   report.docx unpacked/
    python package.py pack     unpacked/ report.docx
    python package.py replace  template.docx out.docx \
        --part word/document.xml=body.xml \
        --add  word/media/fig1.png=charts/fig1.png
    python package.py orphans  report.docx [--strip cleaned.docx]

Why this exists: hand-rolled zip surgery is the top cause of "Word says the
file is corrupt". Two traps this avoids.

1. Reusing a source ``ZipInfo`` -- ``zout.writestr(item, data)`` where ``item``
   came from another archive -- carries that archive's header offset, flag bits
   and extra field into the new one. Python can often still read the result
   while Word (and sometimes ``zipfile`` itself, with "Bad magic number for
   file header") cannot. ``pack`` always builds fresh entries and stores
   ``[Content_Types].xml`` first and uncompressed, as OPC requires.
2. Losing namespace declarations. ``ElementTree`` round-trips drop every
   prefix it was not told about, so ``w14``/``wp14``/``mc`` vanish while
   ``mc:Ignorable`` still names them. Edit parts as bytes, or register every
   prefix first -- see ``register_ooxml_namespaces()``.

Run preflight.py on the result before you hand it to Word.
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from office.helpers import rezip, safe_extract  # noqa: E402

CONTENT_TYPES = "[Content_Types].xml"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

BINARY_CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tiff": "image/tiff",
    "svg": "image/svg+xml",
    "emf": "image/x-emf",
    "wmf": "image/x-wmf",
    "bin": "application/vnd.openxmlformats-officedocument.oleObject",
}

# Every prefix Word/Excel/PowerPoint may declare on a root element. Register
# them before any ElementTree round-trip of a part.
OOXML_NAMESPACES = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "a14": "http://schemas.microsoft.com/office/drawing/2010/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dc": "http://purl.org/dc/elements/1.1/",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "o": "urn:schemas-microsoft-com:office:office",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": REL_NS,
    "v": "urn:schemas-microsoft-com:vml",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "w10": "urn:schemas-microsoft-com:office:word",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16se": "http://schemas.microsoft.com/office/word/2015/wordml/symex",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "wp14": "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}


def register_ooxml_namespaces() -> None:
    for prefix, uri in OOXML_NAMESPACES.items():
        ET.register_namespace(prefix, uri)


def _serialize(root: ET.Element, default_ns: str) -> bytes:
    """Serialize a part whose namespace must stay the unprefixed default.

    `[Content_Types].xml` and `.rels` declare their namespace with no prefix.
    Letting ElementTree invent `ns0:` still parses, but every other tool that
    appends to those parts (comment.py, Word itself) writes unprefixed
    elements, and the mix is what makes Word call the file corrupt.
    """
    ET.register_namespace("", default_ns)
    try:
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    finally:
        register_ooxml_namespaces()


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def unpack(src: Path, dest: Path) -> dict:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as zf:
        safe_extract(zf, dest)
        names = zf.namelist()
    return {"ok": True, "unpacked": str(dest), "parts": len(names)}


def pack(src_dir: Path, out: Path) -> dict:
    if not (src_dir / CONTENT_TYPES).is_file():
        raise SystemExit(f"Error: {src_dir} has no {CONTENT_TYPES}; that is not an unpacked OOXML package")
    out.parent.mkdir(parents=True, exist_ok=True)
    rezip(src_dir, out)
    with zipfile.ZipFile(out) as zf:
        bad = zf.testzip()
    if bad:
        raise SystemExit(f"Error: {out} failed its own CRC check at {bad}")
    return {"ok": True, "file": str(out), "bytes": out.stat().st_size}


def _ensure_content_types(data: bytes, extensions: set[str]) -> bytes:
    if not extensions:
        return data
    register_ooxml_namespaces()
    root = ET.fromstring(data)
    known = {(d.get("Extension") or "").lower() for d in root.findall(_q(CT_NS, "Default"))}
    added = False
    for ext in sorted(extensions):
        if ext in known or ext not in BINARY_CONTENT_TYPES:
            continue
        default = ET.Element(_q(CT_NS, "Default"), {"Extension": ext, "ContentType": BINARY_CONTENT_TYPES[ext]})
        first_override = next(
            (i for i, child in enumerate(list(root)) if child.tag == _q(CT_NS, "Override")), len(root)
        )
        root.insert(first_override, default)
        added = True
    if not added:
        return data
    return _serialize(root, CT_NS)


def _parse_mapping(values: list[str], flag: str) -> dict[str, Path]:
    mapping: dict[str, Path] = {}
    for value in values or []:
        if "=" not in value:
            raise SystemExit(f"Error: {flag} expects 'part/name=localfile', got {value!r}")
        part, local = value.split("=", 1)
        part = part.strip().replace("\\", "/").lstrip("/")
        source = Path(local.strip())
        if not source.is_file():
            raise SystemExit(f"Error: {flag} source does not exist: {source}")
        mapping[part] = source
    return mapping


def replace(template: Path, out: Path, parts: dict[str, Path], additions: dict[str, Path]) -> dict:
    with zipfile.ZipFile(template) as zin:
        existing = {info.filename for info in zin.infolist()}
        missing = [name for name in parts if name not in existing]
        if missing:
            raise SystemExit(f"Error: template has no such part(s): {', '.join(sorted(missing))}")
        payload = {name: zin.read(name) for name in existing}

    for name, source in parts.items():
        payload[name] = source.read_bytes()
    for name, source in additions.items():
        payload[name] = source.read_bytes()

    extensions = {Path(name).suffix.lstrip(".").lower() for name in additions}
    if CONTENT_TYPES in payload:
        payload[CONTENT_TYPES] = _ensure_content_types(payload[CONTENT_TYPES], extensions)

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        zout.writestr(CONTENT_TYPES, payload.pop(CONTENT_TYPES), compress_type=zipfile.ZIP_STORED)
        for name in sorted(payload):
            zout.writestr(name, payload[name])
    with zipfile.ZipFile(tmp) as check:
        bad = check.testzip()
    if bad:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"Error: rebuilt package failed its CRC check at {bad}")
    tmp.replace(out)
    return {
        "ok": True,
        "file": str(out),
        "replaced": sorted(parts),
        "added": sorted(additions),
        "content_types_registered": sorted(extensions & BINARY_CONTENT_TYPES.keys()),
    }


def _reachable(zf: zipfile.ZipFile) -> set[str]:
    """Part names reachable from the package root through relationship files."""
    names = set(zf.namelist())
    reachable: set[str] = set()
    queue = ["_rels/.rels"]
    seen_rels = set()
    while queue:
        rels_name = queue.pop()
        if rels_name in seen_rels or rels_name not in names:
            continue
        seen_rels.add(rels_name)
        reachable.add(rels_name)
        base = rels_name[: -len("_rels/.rels")] if rels_name.endswith("_rels/.rels") else ""
        if rels_name.endswith(".rels") and not rels_name.endswith("_rels/.rels"):
            base = rels_name.rsplit("_rels/", 1)[0]
        try:
            root = ET.fromstring(zf.read(rels_name))
        except ET.ParseError:
            continue
        for rel in root.findall(_q(REL_NS, "Relationship")):
            if (rel.get("TargetMode") or "").lower() == "external":
                continue
            target = (rel.get("Target") or "").replace("\\", "/")
            if not target or "://" in target:
                continue
            part = target.lstrip("/") if target.startswith("/") else _norm(base + target)
            if part in names:
                reachable.add(part)
                head, _, tail = part.rpartition("/")
                child_rels = f"{head}/_rels/{tail}.rels" if head else f"_rels/{tail}.rels"
                queue.append(child_rels)
    return reachable


def _norm(path: str) -> str:
    parts: list[str] = []
    for chunk in path.split("/"):
        if chunk in ("", "."):
            continue
        if chunk == "..":
            if parts:
                parts.pop()
            continue
        parts.append(chunk)
    return "/".join(parts)


def orphans(src: Path, strip_to: Path | None) -> dict:
    with zipfile.ZipFile(src) as zf:
        names = [info.filename for info in zf.infolist() if not info.is_dir()]
        reachable = _reachable(zf)
        dead = sorted(
            name
            for name in names
            if name not in reachable
            and name != CONTENT_TYPES
            and not name.endswith(".rels")
            and not name.startswith("docProps/")
        )
        report: dict = {"ok": True, "parts": len(names), "orphans": dead}
        if strip_to is None or not dead:
            return report
        payload = {name: zf.read(name) for name in names if name not in dead}

    keep = set(payload)
    for rels_name in [n for n in keep if n.endswith(".rels")]:
        try:
            root = ET.fromstring(payload[rels_name])
        except ET.ParseError:
            continue
        removed = False
        base = rels_name.rsplit("_rels/", 1)[0] if not rels_name.endswith("_rels/.rels") else ""
        for rel in list(root.findall(_q(REL_NS, "Relationship"))):
            target = (rel.get("Target") or "").replace("\\", "/")
            if (rel.get("TargetMode") or "").lower() == "external" or "://" in target:
                continue
            part = target.lstrip("/") if target.startswith("/") else _norm(base + target)
            if part in dead:
                root.remove(rel)
                removed = True
        if removed:
            payload[rels_name] = _serialize(root, REL_NS)

    ct_root = ET.fromstring(payload[CONTENT_TYPES])
    for override in list(ct_root.findall(_q(CT_NS, "Override"))):
        if (override.get("PartName") or "").lstrip("/") in dead:
            ct_root.remove(override)
    payload[CONTENT_TYPES] = _serialize(ct_root, CT_NS)

    strip_to.parent.mkdir(parents=True, exist_ok=True)
    tmp = strip_to.with_suffix(strip_to.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        zout.writestr(CONTENT_TYPES, payload.pop(CONTENT_TYPES), compress_type=zipfile.ZIP_STORED)
        for name in sorted(payload):
            zout.writestr(name, payload[name])
    tmp.replace(strip_to)
    report["stripped_to"] = str(strip_to)
    report["bytes"] = strip_to.stat().st_size
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Unpack, repack and patch OOXML packages")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List the parts in a package")
    p_list.add_argument("source")

    p_unpack = sub.add_parser("unpack", help="Extract a package (symlink entries rejected)")
    p_unpack.add_argument("source")
    p_unpack.add_argument("dest")

    p_pack = sub.add_parser("pack", help="Rebuild a package from an unpacked directory")
    p_pack.add_argument("source_dir")
    p_pack.add_argument("out")

    p_replace = sub.add_parser("replace", help="Copy a package, swapping and adding parts")
    p_replace.add_argument("template")
    p_replace.add_argument("out")
    p_replace.add_argument("--part", action="append", metavar="PART=FILE", help="Replace an existing part")
    p_replace.add_argument("--add", action="append", metavar="PART=FILE", help="Add a new part (media, embeddings)")

    p_orphans = sub.add_parser("orphans", help="Report parts unreachable from the rels graph")
    p_orphans.add_argument("source")
    p_orphans.add_argument("--strip", metavar="OUT", help="Write a copy without the orphan parts")

    args = parser.parse_args()

    if args.command == "list":
        with zipfile.ZipFile(Path(args.source)) as zf:
            report = {
                "ok": True,
                "parts": [
                    {"name": info.filename, "bytes": info.file_size}
                    for info in zf.infolist()
                    if not info.is_dir()
                ],
            }
    elif args.command == "unpack":
        report = unpack(Path(args.source), Path(args.dest))
    elif args.command == "pack":
        report = pack(Path(args.source_dir), Path(args.out))
    elif args.command == "replace":
        report = replace(
            Path(args.template),
            Path(args.out),
            _parse_mapping(args.part, "--part"),
            _parse_mapping(args.add, "--add"),
        )
    else:
        report = orphans(Path(args.source), Path(args.strip) if args.strip else None)

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
