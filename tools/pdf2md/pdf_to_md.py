#!/usr/bin/env python3
"""PDF → Markdown with text-layer extraction and selective RapidOCR.

Never writes back to the source PDF. OCR runs only for sparse or formula-shell pages
unless --ocr always/never is set.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("ORT_INTRA_OP_NUM_THREADS", "1")

SPARSE_CHARS = 80
EQ_LINE_RE = re.compile(r"^[\s=＝+\-−×÷·•.．…—–]*$")
ISOLATED_EQ_RE = re.compile(r"^[=＝]{1,4}$")
FORMULA_CUE_RE = re.compile(r"(如式|公式|式\s*[（(]\s*\d+|矩阵如下|equation|where\s+[A-Za-z]\s*[=＝])", re.I)
FRAGMENT_RE = re.compile(r"^[|│┃■□▪▫+\-−×÷·=＝ZYIδθωαβγΔΣ∑∫∂√*∗]+$")


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


def wrap_line(text: str, width: int = 80) -> str:
    text = text.strip()
    if len(text) <= width:
        return text
    parts: list[str] = []
    buf = text
    while len(buf) > width:
        window = buf[: width + 1]
        cut = max(window.rfind(" "), window.rfind("，"), window.rfind("。"), window.rfind("；"), window.rfind("、"))
        end = cut + 1 if cut >= int(width * 0.55) else width
        parts.append(buf[:end].rstrip())
        buf = buf[end:].lstrip()
    if buf:
        parts.append(buf)
    return "\n".join(parts)


def normalize_page_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [wrap_line(line, 80) if len(line) > 120 else line.rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def meaningful_char_count(text: str) -> int:
    return len(re.sub(r"\s+", "", text or ""))


def is_formula_shell(text: str) -> bool:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return False
    isolated = sum(1 for ln in lines if ISOLATED_EQ_RE.match(ln) or EQ_LINE_RE.match(ln) and "=" in ln)
    fragments = sum(1 for ln in lines if FRAGMENT_RE.match(ln) or len(re.sub(r"\s+", "", ln)) <= 2)
    if isolated >= 4 and isolated / max(len(lines), 1) >= 0.12:
        return True
    if fragments >= 10 and fragments / max(len(lines), 1) >= 0.22:
        return True
    if FORMULA_CUE_RE.search(text) and (isolated + fragments) >= 8:
        return True
    if len(lines) >= 8 and isolated >= 3 and meaningful_char_count(text) < 400:
        return True
    return False


def page_needs_ocr(text: str, mode: str, sparse_chars: int) -> bool:
    if mode == "always":
        return True
    if mode == "never":
        return False
    compact = meaningful_char_count(text)
    if compact < sparse_chars:
        return True
    return is_formula_shell(text)


def yaml_quote(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


class OcrEngine:
    def __init__(self) -> None:
        self._engine = None
        self.kind = ""

    def _load(self) -> None:
        if self._engine is not None:
            return
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore

            self._engine = RapidOCR()
            self.kind = "rapidocr_onnxruntime"
            eprint(f"[pdf2md] loaded OCR engine: {self.kind}")
            return
        except Exception as exc:
            eprint(f"[pdf2md] rapidocr_onnxruntime unavailable: {exc}")
        try:
            from rapidocr import RapidOCR  # type: ignore

            self._engine = RapidOCR()
            self.kind = "rapidocr"
            eprint(f"[pdf2md] loaded OCR engine: {self.kind}")
        except Exception as exc:
            raise RuntimeError(f"无法加载 RapidOCR：{exc}") from exc

    def run(self, image_array: Any) -> str:
        self._load()
        result = self._engine(image_array)
        items: list[tuple[float, float, str]] = []
        rows: Any = result
        if isinstance(result, tuple):
            rows = result[0]
        elif hasattr(result, "result"):
            rows = result.result
        if not rows:
            return ""
        for row in rows:
            try:
                if isinstance(row, (list, tuple)) and len(row) >= 2:
                    box, text = row[0], row[1]
                    if not text:
                        continue
                    xs = [p[0] for p in box]
                    ys = [p[1] for p in box]
                    items.append((sum(ys) / 4.0, sum(xs) / 4.0, str(text)))
                elif isinstance(row, dict):
                    text = str(row.get("text") or row.get("txt") or "")
                    if not text:
                        continue
                    box = row.get("box") or row.get("boxes") or [[0, 0]]
                    xs = [p[0] for p in box]
                    ys = [p[1] for p in box]
                    items.append((sum(ys) / 4.0, sum(xs) / 4.0, text))
            except Exception:
                continue
        if not items:
            return ""
        items.sort(key=lambda t: (round(t[0] / 18.0), t[1]))
        lines: list[str] = []
        current_band: float | None = None
        current: list[str] = []
        for y, _x, text in items:
            band = round(y / 18.0)
            if current_band is None:
                current_band = band
            if band != current_band:
                lines.append(" ".join(current))
                current = [text]
                current_band = band
            else:
                current.append(text)
        if current:
            lines.append(" ".join(current))
        return normalize_page_text("\n".join(lines))


_OCR: OcrEngine | None = None


def get_ocr_engine() -> OcrEngine:
    global _OCR
    if _OCR is None:
        _OCR = OcrEngine()
    return _OCR


def render_page_image(page: Any, zoom: float) -> Any:
    import numpy as np
    import pymupdf as fitz
    from PIL import Image

    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    return np.asarray(img)


def convert_pdf(
    input_path: str,
    output_path: str,
    meta_path: str = "",
    ocr_mode: str = "auto",
    zoom: float = 2.0,
    sparse_chars: int = SPARSE_CHARS,
    max_pages: int = 0,
    start_page: int = 1,
) -> dict[str, Any]:
    import pymupdf as fitz

    src = Path(input_path)
    if not src.is_file():
        raise FileNotFoundError(f"PDF 不存在：{input_path}")

    doc = fitz.open(str(src))
    try:
        page_count = doc.page_count
        start = max(1, start_page) - 1
        if max_pages and max_pages > 0:
            limit = min(page_count, start + max_pages)
        else:
            limit = page_count
        ocr: OcrEngine | None = None
        ocr_pages: list[int] = []
        page_blocks: list[str] = []
        extractor = "pymupdf"

        for index in range(start, limit):
            page = doc[index]
            page_no = index + 1
            raw = page.get_text("text") or ""
            text = normalize_page_text(raw)
            used_ocr = False
            if page_needs_ocr(text, ocr_mode, sparse_chars):
                if ocr is None:
                    ocr = get_ocr_engine()
                try:
                    image = render_page_image(page, zoom)
                    ocr_text = ocr.run(image)
                    text_n = meaningful_char_count(text)
                    ocr_n = meaningful_char_count(ocr_text)
                    take_ocr = ocr_n >= max(text_n, 1) if text_n < sparse_chars else ocr_n >= max(int(text_n * 0.55), 80)
                    if take_ocr and ocr_n > 0:
                        text = ocr_text
                        used_ocr = True
                        ocr_pages.append(page_no)
                        extractor = "pymupdf+rapidocr"
                except Exception as exc:
                    eprint(f"[pdf2md] OCR failed on page {page_no}: {exc}")

            if not text:
                text = f"<!-- empty page={page_no} -->"
            elif used_ocr:
                pass
            else:
                images = page.get_images()
                if images:
                    text = f"{text}\n\n<!-- figure page={page_no} -->"

            page_blocks.append(text)
            if page_no == 1 or page_no % 5 == 0 or page_no == limit:
                eprint(
                    f"[pdf2md] page {page_no}/{page_count} ocr={used_ocr} chars={meaningful_char_count(text)}"
                )

        body = "\n\n".join(page_blocks).strip()
        title = src.stem
        front = [
            "---",
            f"title: {yaml_quote(title)}",
            f"page_count: {page_count}",
            f"extractor: {yaml_quote(extractor)}",
            f"ocr_mode: {yaml_quote(ocr_mode)}",
            f"ocr_pages: {json.dumps(ocr_pages)}",
            f"ocr_page_count: {len(ocr_pages)}",
            f"source_pdf: {yaml_quote(str(src))}",
            "---",
            "",
            f"# {title}",
            "",
            body,
            "",
        ]
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("\n".join(front), encoding="utf-8")

        meta = {
            "ok": True,
            "title": title,
            "text": body,
            "numpages": page_count,
            "ocr_pages": ocr_pages,
            "ocr_page_count": len(ocr_pages),
            "extractor": extractor,
            "ocr_mode": ocr_mode,
            "chars": meaningful_char_count(body),
            "output": str(out),
            "source_pdf": str(src),
        }
        if meta_path:
            meta_file = Path(meta_path)
            meta_file.parent.mkdir(parents=True, exist_ok=True)
            meta_file.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            meta["meta"] = str(meta_file)
        return meta
    finally:
        doc.close()


def serve(ocr_mode_default: str, zoom: float, sparse_chars: int) -> None:
    eprint("[pdf2md] serve mode ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req: dict[str, Any]
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": f"invalid json: {exc}"}), flush=True)
            continue
        if req.get("cmd") in {"quit", "exit"}:
            print(json.dumps({"ok": True, "bye": True, "id": req.get("id")}), flush=True)
            break
        ident = req.get("id")
        try:
            result = convert_pdf(
                input_path=req["input"],
                output_path=req["output"],
                meta_path=req.get("meta") or "",
                ocr_mode=str(req.get("ocr") or ocr_mode_default),
                zoom=float(req.get("zoom") or zoom),
                sparse_chars=int(req.get("sparse_chars") or sparse_chars),
                max_pages=int(req.get("max_pages") or 0),
                start_page=int(req.get("start_page") or 1),
            )
            print(
                json.dumps(
                    {
                        "id": ident,
                        "ok": True,
                        "output": result.get("output"),
                        "meta": result.get("meta"),
                        "numpages": result["numpages"],
                        "ocr_pages": result["ocr_pages"],
                        "extractor": result["extractor"],
                        "chars": result["chars"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as exc:
            eprint(traceback.format_exc())
            print(
                json.dumps({"id": ident, "ok": False, "error": str(exc)}, ensure_ascii=False),
                flush=True,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description="PDF to Markdown with selective OCR")
    parser.add_argument("--input", help="source PDF")
    parser.add_argument("--output", help="output Markdown path")
    parser.add_argument("--meta", default="", help="optional JSON sidecar with full text")
    parser.add_argument("--ocr", choices=["auto", "always", "never"], default=os.environ.get("PDF2MD_OCR", "auto"))
    parser.add_argument("--zoom", type=float, default=float(os.environ.get("PDF2MD_ZOOM", "2.0")))
    parser.add_argument("--sparse-chars", type=int, default=int(os.environ.get("PDF2MD_SPARSE_CHARS", str(SPARSE_CHARS))))
    parser.add_argument("--max-pages", type=int, default=0)
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--serve", action="store_true", help="JSONL worker on stdin/stdout")
    args = parser.parse_args()

    if args.serve:
        serve(args.ocr, args.zoom, args.sparse_chars)
        return 0
    if not args.input or not args.output:
        parser.error("--input and --output are required unless --serve")
    result = convert_pdf(
        input_path=args.input,
        output_path=args.output,
        meta_path=args.meta,
        ocr_mode=args.ocr,
        zoom=args.zoom,
        sparse_chars=args.sparse_chars,
        max_pages=args.max_pages,
        start_page=args.start_page,
    )
    summary = {k: v for k, v in result.items() if k != "text"}
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
