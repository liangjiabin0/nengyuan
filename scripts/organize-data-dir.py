#!/usr/bin/env python3
"""整理项目数据目录为 01_论文 / 02_专利 / 03_导师信息 三个子目录。"""
from __future__ import annotations

import os
import re
import shutil
import zipfile
from pathlib import Path

BASE = Path(os.environ.get("DATA_ROOT_DIR", Path(__file__).resolve().parents[1] / "数据")).resolve()
PAPERS = BASE / "01_论文"
PATENTS = BASE / "02_专利"
MENTORS = BASE / "03_导师信息"

PATENT_RE = re.compile(r"专利|发明|实用新型|授权公告|专利申请|ZL\d|CN\d{9,}")

DOC_EXTS = {".caj", ".pdf"}


def is_patent(name: str) -> bool:
    return bool(PATENT_RE.search(name))


def ensure_dirs() -> None:
    for folder in (PAPERS, PATENTS, MENTORS):
        folder.mkdir(parents=True, exist_ok=True)


def move_root_documents() -> dict[str, int]:
    stats = {"papers": 0, "patents": 0, "skipped": 0}
    if not BASE.exists():
        raise FileNotFoundError(f"数据目录不存在: {BASE}")

    for entry in BASE.iterdir():
        if not entry.is_file():
            continue
        ext = entry.suffix.lower()
        if ext not in DOC_EXTS:
            continue
        target_dir = PATENTS if is_patent(entry.name) else PAPERS
        target = target_dir / entry.name
        if target.exists():
            stats["skipped"] += 1
            continue
        shutil.move(str(entry), str(target))
        if target_dir == PATENTS:
            stats["patents"] += 1
        else:
            stats["papers"] += 1
    return stats


def extract_mentor_zip() -> dict[str, int | str]:
    zips = sorted(BASE.glob("*导师*.zip")) + sorted(BASE.glob("03_*.zip"))
    if not zips:
        return {"zip": "", "extracted": 0}
    zip_path = zips[0]
    extracted = 0
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            if member.endswith("/"):
                continue
            if not member.lower().endswith(".md"):
                continue
            name = Path(member).name
            target = MENTORS / name
            if target.exists():
                continue
            with zf.open(member) as src, open(target, "wb") as dst:
                dst.write(src.read())
            extracted += 1
    return {"zip": zip_path.name, "extracted": extracted}


def main() -> None:
    ensure_dirs()
    moved = move_root_documents()
    mentors = extract_mentor_zip()
    print("目录整理完成")
    print(f"  论文移动: {moved['papers']}")
    print(f"  专利移动: {moved['patents']}")
    print(f"  跳过重复: {moved['skipped']}")
    print(f"  导师解压: {mentors['extracted']} 来自 {mentors['zip']}")


if __name__ == "__main__":
    main()
