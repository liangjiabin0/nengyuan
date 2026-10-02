"""
Self-test for the cross-platform OOXML helpers in tools/<skill>/scripts/office.

    python tools/office-docs/selftest_ooxml.py            # docx skill
    python tools/office-docs/selftest_ooxml.py --skill xlsx

Builds a good package and three deliberately broken ones, and asserts that
preflight.py accepts the first and rejects each of the others. Run it from the
repository root; it writes nothing outside a temporary directory.
"""

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

REPO_ROOT = Path(__file__).resolve().parents[2]
MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"


def _load(module_path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _template(skill: str) -> Path:
    asset = REPO_ROOT / "tools" / "docx" / "assets" / "cn-tech-report.docx"
    if asset.is_file():
        return asset
    raise SystemExit(f"missing template asset for {skill}: {asset}")


def _break_namespaces(src: Path, out: Path) -> None:
    """Round-trip document.xml through ElementTree without registering prefixes."""
    with zipfile.ZipFile(src) as zin:
        payload = {info.filename: zin.read(info.filename) for info in zin.infolist() if not info.is_dir()}
    root = ET.fromstring(payload["word/document.xml"])
    root.set(f"{{{MC_NS}}}Ignorable", "w14 w15 wp14")
    payload["word/document.xml"] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in payload.items():
            zout.writestr(name, data)


def _break_content_types(src: Path, out: Path) -> None:
    """Add a media part without registering its extension."""
    with zipfile.ZipFile(src) as zin:
        payload = {info.filename: zin.read(info.filename) for info in zin.infolist() if not info.is_dir()}
    payload["word/media/unregistered.png"] = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in payload.items():
            zout.writestr(name, data)


def _break_relationships(src: Path, out: Path) -> None:
    """Reference a relationship id that document.xml.rels does not declare."""
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(src) as zin:
        payload = {info.filename: zin.read(info.filename) for info in zin.infolist() if not info.is_dir()}
    text = payload["word/document.xml"].decode("utf-8")
    text = text.replace("<w:body>", '<w:body><w:p><w:r><w:drawing><a:blip xmlns:a="x" '
                        f'xmlns:r="{rel_ns}" r:embed="rIdMissing"/></w:drawing></w:r></w:p>', 1)
    payload["word/document.xml"] = text.encode("utf-8")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in payload.items():
            zout.writestr(name, data)


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# A real formula: m:sSup carries the superscript, so it survives conversion.
STRUCTURED_OMML = (
    '<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath>'
    '<m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr>'
    '<m:e><m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>Zsel</m:t></m:r></m:e>'
    '<m:sup><m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>Qtest</m:t></m:r></m:sup>'
    "</m:sSup></m:oMath></m:oMathPara>"
)
ASCII_OMML = '<m:oMath><m:r><m:rPr><m:sty m:val="i"/></m:rPr><m:t>Zsel^Qtest = arg min_x (1)</m:t></m:r></m:oMath>'


def _with_body_xml(src: Path, out: Path, injected: str) -> None:
    """Insert raw XML right after <w:body>, then repack without touching namespaces."""
    with zipfile.ZipFile(src) as zin:
        payload = {info.filename: zin.read(info.filename) for info in zin.infolist() if not info.is_dir()}
    text = payload["word/document.xml"].decode("utf-8")
    payload["word/document.xml"] = text.replace("<w:body>", f"<w:body>{injected}", 1).encode("utf-8")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        zout.writestr("[Content_Types].xml", payload.pop("[Content_Types].xml"), zipfile.ZIP_STORED)
        for name, data in payload.items():
            zout.writestr(name, data)


def _paragraph(text: str) -> str:
    return f'<w:p xmlns:w="{W_NS}"><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def _break_sectpr(src: Path, out: Path) -> None:
    """Duplicate the trailing sectPr, as a template cleaned by hand often does."""
    with zipfile.ZipFile(src) as zin:
        payload = {info.filename: zin.read(info.filename) for info in zin.infolist() if not info.is_dir()}
    text = payload["word/document.xml"].decode("utf-8")
    start = text.rindex("<w:sectPr")
    end = text.index("</w:sectPr>", start) + len("</w:sectPr>")
    block = text[start:end]
    payload["word/document.xml"] = (text[:end] + block + text[end:]).encode("utf-8")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in payload.items():
            zout.writestr(name, data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Self-test the OOXML helper scripts")
    parser.add_argument("--skill", default="docx", choices=("docx", "xlsx", "pptx"))
    args = parser.parse_args()

    office = REPO_ROOT / "tools" / args.skill / "scripts" / "office"
    for name in ("soffice.py", "render.py", "package.py", "preflight.py", "deliverable_check.py"):
        if not (office / name).is_file():
            raise SystemExit(f"missing {office / name}")

    sys.path.insert(0, str(office.parent))
    preflight = _load(office / "preflight.py", "ai4es_preflight")
    package = _load(office / "package.py", "ai4es_package")
    soffice = _load(office / "soffice.py", "ai4es_soffice")
    render = _load(office / "render.py", "ai4es_render")
    deliverable = _load(office / "deliverable_check.py", "ai4es_deliverable")

    results: dict[str, object] = {"skill": args.skill}

    # soffice/render must probe without raising on any platform.
    results["soffice"] = soffice.find_soffice() or "not-installed"
    probe = render.probe()
    assert probe["platform"], "render.probe() returned no platform"
    results["render_probe"] = probe["engines"]["soffice"]["available"]

    template = _template(args.skill)
    with tempfile.TemporaryDirectory(prefix="ooxml_selftest_") as work_str:
        work = Path(work_str)

        # unpack -> pack round-trip stays clean.
        unpacked = work / "unpacked"
        package.unpack(template, unpacked)
        assert (unpacked / "[Content_Types].xml").is_file(), "unpack lost [Content_Types].xml"
        repacked = work / "repacked.docx"
        package.pack(unpacked, repacked)
        report = preflight.preflight(repacked).payload()
        assert report["ok"], f"pack round-trip failed preflight: {report['errors']}"
        assert not report["warnings"], f"pack round-trip raised warnings: {report['warnings']}"

        # replace swaps a part and registers a new media extension.
        body = work / "body.xml"
        shutil.copyfile(unpacked / "word" / "document.xml", body)
        png = work / "fig.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        replaced = work / "replaced.docx"
        info = package.replace(
            template, replaced, {"word/document.xml": body}, {"word/media/fig.png": png}
        )
        assert "png" in info["content_types_registered"], info
        report = preflight.preflight(replaced).payload()
        assert report["ok"], f"replace output failed preflight: {report['errors']}"

        # Each broken package must be rejected, with a message that names the cause.
        cases = {
            "namespaces": (_break_namespaces, "mc:Ignorable"),
            "content_types": (_break_content_types, "Default"),
            "relationships": (_break_relationships, "rIdMissing"),
            "sectpr": (_break_sectpr, "w:sectPr children"),
        }
        detected = {}
        for label, (breaker, needle) in cases.items():
            broken = work / f"broken_{label}.docx"
            breaker(template, broken)
            payload = preflight.preflight(broken).payload()
            assert not payload["ok"], f"preflight accepted the {label} break"
            joined = " ".join(payload["errors"])
            assert needle in joined, f"{label} error message lost the cause: {joined}"
            detected[label] = payload["errors"][0]
        results["detected"] = detected

        # Delivery gate: internal citations, Markdown/LaTeX source and ASCII
        # pseudo-formulas must all be rejected; a real formula must pass.
        clean = work / "clean.docx"
        _with_body_xml(
            template,
            clean,
            f'<w:p xmlns:w="{W_NS}">{STRUCTURED_OMML}</w:p>' + _paragraph("式中，Z 为选择矩阵。"),
        )
        payload = deliverable.check(clean)
        assert payload["ok"], f"delivery gate rejected a clean document: {payload['errors']}"
        assert payload["stats"]["structured_formulas"] == 1, payload["stats"]

        dirty_cases = {
            "corpus-path": _paragraph("该结论见 knowledge-corpus/papers/abc123.md：120-180。"),
            "evidence-chip": _paragraph("该结论有证据支持 [E3]。"),
            "repo-dir": _paragraph("数据来自 repro/demo/results/summary.csv。"),
            "md-bold": _paragraph("这是 **重点** 内容。"),
            "latex-inline": _paragraph("其中 $x^{2}+1$ 为残差。"),
            "ascii-math": f'<w:p xmlns:w="{W_NS}">{ASCII_OMML}</w:p>',
            "toc-cache": (
                f'<w:p xmlns:w="{W_NS}"><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                '<w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r>'
                '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                '<w:r><w:t>请更新字段</w:t></w:r>'
                '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
            ),
        }
        rejected = {}
        for code, injected in dirty_cases.items():
            dirty = work / f"dirty_{code}.docx"
            _with_body_xml(template, dirty, injected)
            payload = deliverable.check(dirty)
            codes = {item["code"] for item in payload["errors"]}
            assert code in codes, f"delivery gate missed {code}: {sorted(codes)}"
            rejected[code] = True
        results["delivery_gate"] = sorted(rejected)

        # Formula survival through the real renderer, when this machine has one.
        if probe["engines"]["soffice"]["available"] or (
            os.name == "nt" and any(probe["engines"]["office"].values())
        ):
            pdf = work / "clean.pdf"
            rendered = render.to_pdf(clean, pdf, timeout=240)
            assert rendered["ok"], f"render failed: {rendered['attempts']}"
            math = render._verify_math(clean, pdf)
            assert math["status"] == "ok", f"the renderer lost the formula: {math}"
            results["math_in_pdf"] = math
        else:
            results["math_in_pdf"] = "no-renderer"

        # The CLI must agree with the library and exit non-zero.
        cli = subprocess.run(
            [sys.executable, str(office / "preflight.py"), str(work / "broken_namespaces.docx"), "--json"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert cli.returncode == 1, f"preflight CLI exit {cli.returncode}, expected 1"
        assert not json.loads(cli.stdout)["ok"], "preflight CLI reported ok for a broken file"

    results["ok"] = True
    print(json.dumps(results, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
