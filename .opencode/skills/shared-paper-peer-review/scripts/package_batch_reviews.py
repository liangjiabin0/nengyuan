#!/usr/bin/env python3
"""Package reviewed manuscripts into a ZIP with exactly 原文/ and 审稿意见/ folders.

Manifest format:
{
  "papers": [
    {"paper_title": "Title", "source_path": "/path/paper.pdf", "review_path": "/path/review.docx"}
  ]
}
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_title(title: str) -> str:
    t = ILLEGAL.sub("_", title).strip().rstrip(".")
    return t or "未命名论文"


def package(manifest: dict, output: Path) -> None:
    papers = manifest.get("papers", [])
    if not papers:
        raise ValueError("manifest.papers is empty")
    with tempfile.TemporaryDirectory(prefix="paper-review-package-") as td:
        root = Path(td)
        original_dir = root / "原文"
        review_dir = root / "审稿意见"
        original_dir.mkdir()
        review_dir.mkdir()

        seen: set[str] = set()
        for item in papers:
            title = safe_title(str(item["paper_title"]))
            if title in seen:
                raise ValueError(f"duplicate paper title: {title}")
            seen.add(title)
            src = Path(item["source_path"])
            rev = Path(item["review_path"])
            if not src.is_file():
                raise FileNotFoundError(src)
            if not rev.is_file():
                raise FileNotFoundError(rev)
            if rev.suffix.lower() != ".docx":
                raise ValueError(f"review must be DOCX: {rev}")
            shutil.copy2(src, original_dir / f"{title}{src.suffix}")
            shutil.copy2(rev, review_dir / f"{title}审稿意见.docx")

        originals = list(original_dir.iterdir())
        reviews = list(review_dir.iterdir())
        if len(originals) != len(reviews):
            raise RuntimeError("primary manuscript count does not match review count")

        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for folder in (original_dir, review_dir):
                zf.writestr(folder.name + "/", "")
                for path in sorted(folder.iterdir(), key=lambda p: p.name):
                    zf.write(path, arcname=f"{folder.name}/{path.name}")

    with zipfile.ZipFile(output) as zf:
        bad = zf.testzip()
        if bad:
            raise RuntimeError(f"ZIP integrity failed at {bad}")
        top = {name.split("/", 1)[0] for name in zf.namelist() if name}
        if top != {"原文", "审稿意见"}:
            raise RuntimeError(f"unexpected top-level folders: {top}")
    print(f"Packaged: {output}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    package(manifest, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
