#!/usr/bin/env python3
"""Extract CN patent PDFs from a zip and optionally warm the pdf2md text cache."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

CN_RE = re.compile(r"(CN[\s_-]?\d{7,13}[\s_-]?[A-Z]?)", re.I)


def decode_zip_name(name: str) -> str:
    try:
        return name.encode("cp437").decode("gbk")
    except Exception:
        try:
            return name.encode("cp437").decode("utf-8")
        except Exception:
            return name


def normalize_pub(name: str) -> str:
    match = CN_RE.search(name)
    if not match:
        return ""
    return re.sub(r"[\s_-]+", "", match.group(1)).upper()


def extract_zip(zip_path: Path, out_dir: Path) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = {"extracted": 0, "skipped": 0, "ignored": 0}
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir() or info.file_size <= 0:
                continue
            raw_name = decode_zip_name(info.filename)
            base = Path(raw_name).name
            if not base.lower().endswith(".pdf"):
                stats["ignored"] += 1
                continue
            pub = normalize_pub(base)
            dest = out_dir / f"{pub or Path(base).stem}.pdf"
            if dest.exists() and dest.stat().st_size == info.file_size:
                stats["skipped"] += 1
                continue
            with zf.open(info) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            stats["extracted"] += 1
            if (stats["extracted"] + stats["skipped"]) % 500 == 0:
                print(
                    f"[extract] extracted={stats['extracted']} skipped={stats['skipped']}",
                    flush=True,
                )
    return stats


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cache_one(pdf_path: str, cache_dir: str) -> tuple[str, bool, int, str]:
    path = Path(pdf_path)
    dest_dir = Path(cache_dir)
    try:
        import pymupdf
    except Exception:
        import fitz as pymupdf  # type: ignore

    digest = sha1_file(path)
    md_path = dest_dir / f"{digest}.md"
    meta_path = dest_dir / f"{digest}.json"
    if md_path.exists() and meta_path.exists() and meta_path.stat().st_size > 40:
        return (path.name, True, 0, "")
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        pages.append(page.get_text("text") or "")
    text = "\n".join(pages).replace("\r\n", "\n").strip()
    page_count = doc.page_count
    doc.close()
    if len(re.sub(r"\s+", "", text)) < 80:
        return (path.name, False, page_count, "text-too-short")
    dest_dir.mkdir(parents=True, exist_ok=True)
    md_path.write_text(text, encoding="utf-8")
    meta_path.write_text(
        json.dumps(
            {
                "text": text,
                "numpages": page_count,
                "extractor": "pymupdf",
                "ocr_pages": [],
                "title": path.stem,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return (path.name, False, page_count, "")


def warm_cache(pdf_dir: Path, cache_dir: Path, workers: int) -> dict[str, int]:
    files = sorted(p for p in pdf_dir.glob("*.pdf") if p.is_file())
    stats = {"cached": 0, "wrote": 0, "failed": 0}
    cache_dir.mkdir(parents=True, exist_ok=True)
    if not files:
        return stats
    workers = max(1, min(workers, os.cpu_count() or 4))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(cache_one, str(path), str(cache_dir)) for path in files]
        for i, future in enumerate(as_completed(futures), 1):
            name, cached, _pages, error = future.result()
            if error:
                stats["failed"] += 1
                print(f"[cache] fail {name}: {error}", flush=True)
            elif cached:
                stats["cached"] += 1
            else:
                stats["wrote"] += 1
            if i % 200 == 0 or i == len(files):
                print(
                    f"[cache] {i}/{len(files)} wrote={stats['wrote']} hit={stats['cached']} fail={stats['failed']}",
                    flush=True,
                )
    return stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--cache-dir", default="")
    parser.add_argument("--workers", type=int, default=max(4, (os.cpu_count() or 8) - 2))
    parser.add_argument("--skip-cache", action="store_true")
    args = parser.parse_args()

    zip_path = Path(args.zip)
    out_dir = Path(args.out)
    if not zip_path.exists():
        print(f"zip not found: {zip_path}", file=sys.stderr)
        return 2

    print(f"[extract] {zip_path} -> {out_dir}", flush=True)
    extracted = extract_zip(zip_path, out_dir)
    print(f"[extract] done {extracted}", flush=True)

    cache_stats = {}
    if not args.skip_cache and args.cache_dir:
        cache_stats = warm_cache(out_dir, Path(args.cache_dir), args.workers)
        print(f"[cache] done {cache_stats}", flush=True)

    print(json.dumps({"extract": extracted, "cache": cache_stats}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
