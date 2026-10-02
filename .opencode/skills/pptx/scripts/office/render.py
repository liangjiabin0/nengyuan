"""
Render a .docx / .xlsx / .pptx to PDF (and optionally to page images) on
Windows, Linux or macOS, always within a bounded time.

Engines, tried in this order unless --engine pins one:

1. ``soffice``  -- LibreOffice, wherever office.soffice finds it.
2. ``office``   -- Windows only: Word / Excel / PowerPoint through COM, run in
                   a child PowerShell process that is killed on timeout.  Any
                   Office process this script started is killed too, so a hung
                   export cannot leak a WINWORD that blocks the next attempt.

Usage:
    python render.py --probe                       # which engines exist here
    python render.py report.docx                   # -> report.pdf next to it
    python render.py report.docx --pages --dpi 100 # + page-01.jpg ...
    python render.py report.docx --timeout 120 --json

Exit codes:
    0  rendered
    3  no engine available on this machine -- say the layout was not previewed
       and move on; do not retry
    4  the engine timed out or hung
    5  the PDF lost the document's formulas -- do not ship it
    1  the engine ran and failed

A .pdf source is not converted, only rasterized into page images. Page images
come from pdftoppm when it exists and from pypdfium2 otherwise.

The math check exists because a PDF rebuilt from paragraph text (python-docx,
ReportLab) cannot see `m:t` math runs: the formulas silently disappear
while the PDF still looks complete. Only a real renderer preserves them.
``math.status`` is ``missing`` (exit 5) when at least half of the checkable
formulas are gone; ``review`` names the few the text layer scrambled -- look
at those on the page images, do not rewrite them.

It answers "did this PDF keep the formulas", not "are the formulas any good":
ASCII pasted into a single `m:r` reaches the PDF as text and passes here.
`deliverable_check.py` is what rejects those.

A non-zero exit never means the document is broken. Validate structure with
preflight.py (fast) and validate.py (XSD) -- those answer "will Word open it",
which is a different question from "can this machine draw it".
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from office.soffice import find_soffice, run_soffice  # noqa: E402

NO_ENGINE_EXIT = 3
TIMEOUT_EXIT = 4
MATH_LOST_EXIT = 5

COM_KINDS = {
    ".docx": "word",
    ".docm": "word",
    ".doc": "word",
    ".dotx": "word",
    ".rtf": "word",
    ".xlsx": "excel",
    ".xlsm": "excel",
    ".xls": "excel",
    ".pptx": "powerpoint",
    ".ppt": "powerpoint",
    ".potx": "powerpoint",
}

COM_PROCESSES = {"word": "WINWORD", "excel": "EXCEL", "powerpoint": "POWERPNT"}

_COM_SCRIPT = r"""
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][string]$Kind
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

function Quiet-Printer($app) {
  try { $app.ActivePrinter = 'Microsoft Print to PDF' } catch {}
}

$app = $null
$doc = $null
try {
  if ($Kind -eq 'word') {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    foreach ($name in 'WarnBeforeSavingPrintingSendingMarkup','UpdateFieldsAtPrint','PrintBackground','CheckSpellingAsYouType','CheckGrammarAsYouType','BackgroundSave') {
      try { $app.Options.$name = $false } catch {}
    }
    Quiet-Printer $app
    $doc = $app.Documents.Open($InputPath, $false, $true)
    $doc.ExportAsFixedFormat($OutputPath, 17)
    $doc.Close($false)
  }
  elseif ($Kind -eq 'excel') {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $doc = $app.Workbooks.Open($InputPath, 0, $true)
    $doc.ExportAsFixedFormat(0, $OutputPath)
    $doc.Close($false)
  }
  else {
    $app = New-Object -ComObject PowerPoint.Application
    $app.DisplayAlerts = 1
    $doc = $app.Presentations.Open($InputPath, $true, $false, $false)
    $doc.SaveAs($OutputPath, 32)
    $doc.Close()
  }
  $app.Quit()
  'render-ok'
}
catch {
  if ($doc) { try { $doc.Close($false) } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($doc) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) } catch {} }
  if ($app) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {} }
}
"""


def _decoded(**kwargs) -> dict:
    """Decode child output without ever raising.

    PowerShell, tasklist and soffice print in the console code page (GBK on a
    Chinese Windows) while Python may run in UTF-8 mode; text=True alone then
    dies in a reader thread with UnicodeDecodeError and the render is lost.
    """
    return {"capture_output": True, "text": True, "encoding": "utf-8", "errors": "replace", **kwargs}


def _powershell() -> str | None:
    return shutil.which("pwsh") or shutil.which("powershell")


def _office_available(kind: str) -> bool:
    if os.name != "nt" or not _powershell():
        return False
    prog_id = {"word": "Word.Application", "excel": "Excel.Application", "powerpoint": "PowerPoint.Application"}[kind]
    try:
        probe = subprocess.run(
            [_powershell(), "-NoProfile", "-Command", f"if ([Type]::GetTypeFromProgID('{prog_id}')) {{ 'yes' }} else {{ 'no' }}"],
            **_decoded(timeout=30),
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "yes" in (probe.stdout or "")


def _pids(image: str) -> set[str]:
    if os.name != "nt":
        return set()
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {image}.EXE", "/NH", "/FO", "CSV"],
            **_decoded(timeout=30),
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return set()
    pids = set()
    for line in out.splitlines():
        fields = [f.strip('" ') for f in line.split('","')]
        if len(fields) > 1 and fields[1].isdigit():
            pids.add(fields[1])
    return pids


def _kill(pids: set[str]) -> None:
    for pid in pids:
        subprocess.run(["taskkill", "/PID", pid, "/F", "/T"], capture_output=True)


def _render_soffice(src: Path, pdf: Path, timeout: int) -> dict:
    exe = find_soffice()
    if not exe:
        return {"engine": "soffice", "status": "unavailable"}
    with tempfile.TemporaryDirectory(prefix="lo_out_") as outdir:
        try:
            done = run_soffice(
                ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", outdir, str(src)],
                **_decoded(timeout=timeout),
            )
        except subprocess.TimeoutExpired:
            return {"engine": "soffice", "status": "timeout", "timeout": timeout}
        produced = next(iter(sorted(Path(outdir).glob("*.pdf"))), None)
        if done.returncode != 0 or produced is None:
            detail = (done.stderr or done.stdout or "").strip()[-600:]
            return {"engine": "soffice", "status": "failed", "detail": detail or f"exit {done.returncode}"}
        pdf.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(produced), str(pdf))
    return {"engine": "soffice", "status": "ok", "exe": exe}


def _render_office(src: Path, pdf: Path, timeout: int) -> dict:
    kind = COM_KINDS.get(src.suffix.lower())
    if not kind or not _office_available(kind):
        return {"engine": "office", "status": "unavailable"}
    image = COM_PROCESSES[kind]
    before = _pids(image)
    pdf.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="com_render_") as workdir:
        script = Path(workdir) / "render.ps1"
        script.write_text(_COM_SCRIPT, encoding="ascii")
        cmd = [
            _powershell(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-InputPath",
            str(src.resolve()),
            "-OutputPath",
            str(pdf.resolve()),
            "-Kind",
            kind,
        ]
        try:
            done = subprocess.run(cmd, **_decoded(timeout=timeout))
        except subprocess.TimeoutExpired:
            _kill(_pids(image) - before)
            return {
                "engine": "office",
                "status": "timeout",
                "timeout": timeout,
                "detail": (
                    f"{image} did not finish the PDF export in {timeout}s and was killed. "
                    "This machine's Office cannot be used for preview; install LibreOffice "
                    "or set AI4ES_SOFFICE."
                ),
            }
    leaked = _pids(image) - before
    if leaked:
        _kill(leaked)
    if done.returncode != 0 or not pdf.exists():
        detail = (done.stderr or done.stdout or "").strip()[-600:]
        return {"engine": "office", "status": "failed", "detail": detail or f"exit {done.returncode}"}
    return {"engine": "office", "status": "ok"}


def to_pdf(src: Path, pdf: Path, engine: str = "auto", timeout: int = 180) -> dict:
    """Render src to pdf with the first engine that works. Never raises, never hangs."""
    order = ["soffice", "office"] if engine == "auto" else [engine]
    attempts = []
    for name in order:
        result = _render_soffice(src, pdf, timeout) if name == "soffice" else _render_office(src, pdf, timeout)
        attempts.append(result)
        if result["status"] == "ok":
            return {"ok": True, "pdf": str(pdf), "attempts": attempts}
    return {"ok": False, "attempts": attempts}


def pdftoppm_path() -> str | None:
    override = (os.environ.get("PDFTOPPM_PATH") or "").strip().strip('"')
    if override and Path(override).is_file():
        return override
    return shutil.which("pdftoppm")


def _pdftoppm() -> str | None:
    return pdftoppm_path()


def _docx_formulas(src: Path) -> list[str]:
    if src.suffix.lower() not in (".docx", ".docm", ".dotx"):
        return []
    math_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
    formulas = []
    try:
        with zipfile.ZipFile(src) as zf:
            names = [n for n in zf.namelist() if n.startswith("word/") and n.endswith(".xml")]
            for name in names:
                try:
                    root = ElementTree.fromstring(zf.read(name))
                except ElementTree.ParseError:
                    continue
                for omath in root.iter(f"{math_ns}oMath"):
                    text = "".join(node.text or "" for node in omath.iter(f"{math_ns}t"))
                    if text.strip():
                        formulas.append(text)
    except (zipfile.BadZipFile, OSError):
        return []
    return formulas


def _signature(text: str) -> str:
    """Alphanumeric skeleton of a string, comparable across renderers.

    Word draws math zones with Mathematical Italic code points (U+1D44E…) and
    U+2212 for the minus sign, and a structured OMML formula renders without its
    ``_``/``^`` markup at all. Folding to NFKC and keeping only letters and digits
    leaves a skeleton that survives every renderer while staying long enough that
    surrounding prose cannot match it by accident.
    """
    return re.sub(r"[^A-Za-z0-9]", "", unicodedata.normalize("NFKC", text))


def _window_holds(haystack: str, signature: str) -> bool:
    """True when some span of haystack contains every character of signature.

    Order is deliberately ignored. A renderer lays an n-ary operator out
    visually, so ``\\sum_{i=1}^{N} x_i`` reaches the PDF text layer as body,
    then upper limit, then lower limit -- a substring match against the linear
    signature fails on a formula that is plainly there. Requiring the same
    characters inside a bounded window still rejects a PDF that was rebuilt
    from paragraph text, where those characters are absent altogether.
    """
    if len(signature) > len(haystack):
        return False
    need = Counter(signature)
    size = min(len(haystack), len(signature) * 2 + 8)
    window = Counter(haystack[:size])

    def covers() -> bool:
        return all(window[char] >= count for char, count in need.items())

    if covers():
        return True
    for index in range(size, len(haystack)):
        window[haystack[index]] += 1
        leaving = haystack[index - size]
        window[leaving] -= 1
        if window[leaving] == 0:
            del window[leaving]
        if covers():
            return True
    return False


def verify_math(src: Path, pdf: Path) -> dict:
    """Confirm the rendered PDF still contains every formula the .docx declares.

    A PDF rebuilt from paragraph text (python-docx, pandoc, ReportLab) silently
    drops math runs, so the formulas vanish while the file still looks fine.
    """
    formulas = _docx_formulas(src)
    if not formulas:
        return {"status": "skipped", "formulas": 0}
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"status": "unavailable", "formulas": len(formulas), "hint": "pip install pypdf"}
    try:
        reader = PdfReader(str(pdf))
        raw = "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as exc:  # pypdf raises a wide range on damaged files
        return {"status": "unavailable", "formulas": len(formulas), "detail": str(exc)[:200]}
    haystack = _signature(raw)

    missing, partial, unverifiable, present = [], [], 0, 0
    for text in formulas:
        signature = _signature(text)
        if len(signature) < 4:
            unverifiable += 1
        elif signature in haystack or _window_holds(haystack, signature):
            present += 1
        elif len(signature) >= 10 and _window_holds(haystack, signature[: len(signature) // 2]):
            partial.append(text[:80])
        else:
            missing.append(text[:80])
    # A PDF rebuilt from paragraph text loses the math wholesale. One formula the
    # text layer scrambles (large n-ary operators, stacked limits) is a renderer
    # quirk, not a lost formula: report it for a look at the page image instead
    # of failing, so nobody rewrites a correct equation to please this check.
    verifiable = present + len(partial) + len(missing)
    if missing and len(missing) * 2 >= verifiable:
        status = "missing"
    elif missing or partial:
        status = "review"
    else:
        status = "ok"
    return {
        "status": status,
        "formulas": len(formulas),
        "present": present,
        "partial": partial,
        "unverifiable": unverifiable,
        "missing": missing,
    }


_verify_math = verify_math


def _rasterize_pdfium(pdf: Path, dpi: int) -> dict:
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return {"status": "unavailable", "hint": "install Poppler (pdftoppm) or pypdfium2"}
    prefix = pdf.with_suffix("")
    files = []
    document = pdfium.PdfDocument(str(pdf))
    try:
        width = max(2, len(str(len(document))))
        for index in range(len(document)):
            image = document[index].render(scale=dpi / 72).to_pil().convert("RGB")
            target = prefix.parent / f"{prefix.name}-page-{index + 1:0{width}d}.jpg"
            image.save(target, quality=85)
            files.append(str(target))
    finally:
        document.close()
    return {"status": "ok", "files": files, "engine": "pypdfium2"}


def rasterize(pdf: Path, dpi: int, timeout: int = 180) -> dict:
    """Write <pdf stem>-page-NN.jpg next to the PDF; pdftoppm first, pypdfium2 otherwise."""
    exe = _pdftoppm()
    if not exe:
        return _rasterize_pdfium(pdf, dpi)
    prefix = pdf.with_suffix("")
    try:
        done = subprocess.run(
            [exe, "-jpeg", "-r", str(dpi), str(pdf), f"{prefix}-page"],
            **_decoded(timeout=timeout),
        )
    except subprocess.TimeoutExpired:
        return {"status": "timeout"}
    if done.returncode != 0:
        fallback = _rasterize_pdfium(pdf, dpi)
        if fallback["status"] == "ok":
            return fallback
        return {"status": "failed", "detail": (done.stderr or "").strip()[-400:]}
    pages = sorted(str(p) for p in prefix.parent.glob(f"{prefix.name}-page*.jpg"))
    return {"status": "ok", "files": pages}


_rasterize = rasterize


def probe() -> dict:
    engines = {}
    exe = find_soffice()
    engines["soffice"] = {"available": bool(exe), "exe": exe}
    if os.name == "nt":
        engines["office"] = {kind: _office_available(kind) for kind in COM_PROCESSES}
    else:
        engines["office"] = {"available": False, "reason": "COM is Windows-only"}
    engines["pdftoppm"] = {"available": bool(_pdftoppm()), "exe": _pdftoppm()}
    return {"platform": sys.platform, "engines": engines}


def main() -> int:
    parser = argparse.ArgumentParser(description="Render an Office document to PDF on any platform")
    parser.add_argument("source", nargs="?", help="Path to the .docx/.xlsx/.pptx, or a .pdf to turn into page images")
    parser.add_argument("--pdf", help="Output PDF path (default: alongside the source)")
    parser.add_argument("--engine", choices=("auto", "soffice", "office"), default="auto")
    parser.add_argument("--timeout", type=int, default=180, help="Seconds per engine attempt")
    parser.add_argument("--pages", action="store_true", help="Also write page images via pdftoppm")
    parser.add_argument("--dpi", type=int, default=100)
    parser.add_argument("--probe", action="store_true", help="Report available engines and exit")
    parser.add_argument("--json", action="store_true", help="Machine-readable report on stdout")
    parser.add_argument(
        "--skip-math-check",
        action="store_true",
        help="Do not verify that the PDF still contains the document's formulas",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Do not render; only check that the PDF given by --pdf still holds the source's formulas",
    )
    args = parser.parse_args()

    if args.probe:
        report = probe()
        print(json.dumps(report, indent=2, ensure_ascii=False))
        usable = report["engines"]["soffice"]["available"] or (
            os.name == "nt" and any(report["engines"]["office"].values())
        )
        return 0 if usable else NO_ENGINE_EXIT

    if not args.source:
        parser.error("source is required unless --probe is given")

    src = Path(args.source)
    if not src.is_file():
        print(f"Error: {src} does not exist", file=sys.stderr)
        return 1
    if src.suffix.lower() == ".pdf":
        # Already a PDF (a paper, an exported deck): only page images are needed.
        pages = rasterize(src, args.dpi, args.timeout)
        print(json.dumps({"ok": pages["status"] == "ok", "pdf": str(src), "pages": pages}, indent=2, ensure_ascii=False))
        return 0 if pages["status"] == "ok" else 1

    pdf = Path(args.pdf) if args.pdf else src.with_suffix(".pdf")

    if args.verify_only:
        if not pdf.is_file():
            print(f"Error: {pdf} does not exist", file=sys.stderr)
            return 1
        math = _verify_math(src, pdf)
        print(json.dumps({"pdf": str(pdf), "math": math}, indent=2, ensure_ascii=False))
        return MATH_LOST_EXIT if math["status"] == "missing" else 0

    report = to_pdf(src, pdf, engine=args.engine, timeout=args.timeout)
    attempts = report["attempts"]
    if report["ok"]:
        if args.pages:
            report["pages"] = _rasterize(pdf, args.dpi, args.timeout)
        math = _verify_math(src, pdf) if not args.skip_math_check else {"status": "disabled"}
        report["math"] = math
        print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else f"rendered: {pdf}")
        if math["status"] == "missing":
            print(
                f"Error: {len(math['missing'])} of {math['formulas']} formulas are absent from {pdf}. "
                "Do not ship this PDF: it was not produced from the document's math runs. "
                "Render with this script (LibreOffice/Word), never by re-typesetting paragraph text.",
                file=sys.stderr,
            )
            return MATH_LOST_EXIT
        return 0

    print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
    statuses = {a["status"] for a in attempts}
    if statuses == {"unavailable"}:
        print(
            "No renderer on this machine: LibreOffice is absent"
            + (" and Office COM is unavailable." if os.name == "nt" else " (COM is Windows-only).")
            + " Report that page images were not checked; do not retry.",
            file=sys.stderr,
        )
        return NO_ENGINE_EXIT
    if "timeout" in statuses:
        return TIMEOUT_EXIT
    return 1


if __name__ == "__main__":
    sys.exit(main())
