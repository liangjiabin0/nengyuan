#!/usr/bin/env python3
"""Unzip guide literature packs and extract PDF/DOCX/TXT into Markdown.

Reading range is decided later by the model; this host step only materializes
full text so the agent is not blocked by unread binaries.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

DOCX_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
MANUSCRIPT_NAME_RE = re.compile(r"指南|评估及提升|建议稿")
ROOT_MANUSCRIPT_RE = re.compile(r"指南|评估及提升|建议稿|方法")
SAFE_NAME_RE = re.compile(r"[^\w\u4e00-\u9fff.-]+", re.UNICODE)


def chinese_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text or ""))


def safe_name(value: str, fallback: str) -> str:
    stem = SAFE_NAME_RE.sub("_", value).strip("._") or fallback
    return stem[:80]


def decode_zip_name(info: zipfile.ZipInfo) -> str:
    raw = info.filename
    if info.flag_bits & 0x800:
        return raw
    try:
        return raw.encode("cp437").decode("gbk")
    except Exception:
        try:
            return raw.encode("cp437").decode("utf-8")
        except Exception:
            return raw


def safe_extract_path(dest: Path, member_name: str) -> Path | None:
    cleaned = member_name.replace("\\", "/").lstrip("/")
    if not cleaned or cleaned.endswith("/"):
        return None
    parts = [part for part in cleaned.split("/") if part not in ("", ".", "..")]
    if not parts:
        return None
    target = dest.joinpath(*parts)
    try:
        target.resolve().relative_to(dest.resolve())
    except Exception:
        return None
    return target


def extract_zip(zip_path: Path, dest: Path) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = decode_zip_name(info)
            if info.is_dir() or name.endswith("/"):
                continue
            target = safe_extract_path(dest, name)
            if target is None:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())
            written.append(target)
    return written


def pdf_text(path: Path) -> str:
    try:
        import pymupdf

        doc = pymupdf.open(path)
        parts: list[str] = []
        try:
            for index, page in enumerate(doc, start=1):
                text = (page.get_text("text") or "").strip()
                if text:
                    parts.append(f"## 第 {index} 页\n\n{text}")
        finally:
            doc.close()
        if parts:
            return "\n\n".join(parts)
    except Exception:
        pass
    try:
        from pdfminer.high_level import extract_text

        text = (extract_text(str(path)) or "").strip()
        if text:
            return text
    except Exception:
        pass
    return ""


def docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("word/document.xml")
    except Exception:
        return ""
    root = ET.fromstring(xml)
    paragraphs: list[str] = []
    for para in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
        texts = [
            node.text or ""
            for node in para.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
        ]
        line = "".join(texts).strip()
        if line:
            paragraphs.append(line)
    return "\n\n".join(paragraphs)


def read_text_file(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gbk", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except Exception:
            continue
    return path.read_bytes().decode("utf-8", errors="ignore")


def convert_file(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return pdf_text(path)
    if suffix in {".docx", ".doc"}:
        return docx_text(path)
    if suffix in {".md", ".markdown", ".txt", ".text"}:
        return read_text_file(path).strip()
    return ""


def iter_source_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() in {".pdf", ".docx", ".doc", ".md", ".markdown", ".txt", ".text"}:
            files.append(path)
    files.sort(key=lambda item: str(item).lower())
    return files


def is_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


def choose_manuscript(literature: Path, extracted_files: list[Path]) -> Path | None:
    root_docs = [
        path
        for path in literature.iterdir()
        if path.is_file() and path.suffix.lower() in {".docx", ".doc", ".md", ".markdown"}
    ]
    for path in root_docs:
        if ROOT_MANUSCRIPT_RE.search(path.stem):
            return path
    if len(root_docs) == 1:
        return root_docs[0]
    for path in extracted_files:
        if path.suffix.lower() in {".docx", ".doc", ".md"} and MANUSCRIPT_NAME_RE.search(path.stem):
            return path
    return None


def write_markdown(out_file: Path, title: str, source: str, body: str) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    header = [
        f"# {title}",
        "",
        f"- 来源：{source}",
        f"- 汉字约 {chinese_count(body)}",
        "",
        body.strip(),
        "",
    ]
    out_file.write_text("\n".join(header), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--literature", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    literature: Path = args.literature
    out_dir: Path = args.out
    documents_dir = out_dir / "documents"
    archives_dir = out_dir / "archives"
    out_dir.mkdir(parents=True, exist_ok=True)
    documents_dir.mkdir(parents=True, exist_ok=True)

    errors: list[str] = []
    archive_count = 0
    zip_queue = [
        path
        for path in literature.iterdir()
        if path.is_file() and path.suffix.lower() == ".zip"
    ] if literature.exists() else []
    processed_zips = 0
    while zip_queue and processed_zips < 80:
        current = zip_queue.pop(0)
        dest = archives_dir / safe_name(current.stem, f"archive-{archive_count + 1}")
        try:
            written = extract_zip(current, dest)
            archive_count += 1
            for path in written:
                if path.suffix.lower() == ".zip":
                    zip_queue.append(path)
        except Exception as exc:
            errors.append(f"解压失败 {current.name}: {exc}")
        processed_zips += 1

    sources = []
    if literature.exists():
        for path in iter_source_files(literature):
            if is_under(path, documents_dir):
                continue
            if is_under(path, out_dir) and not is_under(path, archives_dir):
                continue
            sources.append(path)
    documents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, source in enumerate(sources, start=1):
        if source.suffix.lower() == ".zip":
            continue
        if source.parent.resolve() == literature.resolve() and source.name.lower().endswith(".md") and ".converted." not in source.name.lower():
            # 工作区缓存占位 md，不是文献全文
            continue
        key = source.name.lower()
        if key in seen:
            continue
        seen.add(key)
        body = convert_file(source)
        if chinese_count(body) < 80 and len(body) < 400:
            errors.append(f"抽取过短或失败：{source.name}")
            if not body.strip():
                continue
        doc_id = f"LIT-{index:03d}"
        title = source.stem
        relative = Path("documents") / f"{doc_id}_{safe_name(title, doc_id)}.md"
        write_markdown(out_dir / relative, title, str(source.relative_to(literature)).replace("\\", "/"), body)
        documents.append(
            {
                "id": doc_id,
                "title": title,
                "relative": relative.as_posix(),
                "source": str(source.relative_to(literature)).replace("\\", "/"),
                "chars": len(body),
                "chinese": chinese_count(body),
            }
        )

    manuscript_meta = None
    manuscript = choose_manuscript(literature, sources) if literature.exists() else None
    if manuscript is not None:
        body = convert_file(manuscript)
        if body.strip():
            write_markdown(out_dir / "manuscript.md", manuscript.stem, manuscript.name, body)
            manuscript_meta = {
                "relative": "manuscript.md",
                "source": manuscript.name,
                "chars": len(body),
                "chinese": chinese_count(body),
            }

    index_lines = [
        "# 文献全文抽取",
        "",
        f"- 压缩包：{archive_count} 个",
        f"- 全文：{len(documents)} 份",
        f"- 原稿：{manuscript_meta['source'] if manuscript_meta else '无'}",
        "",
        "直接 `read` 下列 Markdown。不要因为原文件是 PDF/ZIP 而只看文件名。",
        "",
    ]
    if manuscript_meta:
        index_lines += [f"- 原稿全文：`literature/extracted/{manuscript_meta['relative']}`", ""]
    for item in documents:
        index_lines.append(
            f"- `{item['id']}` `{item['relative']}` — {item['title']}（约 {item['chinese']} 汉字）"
        )
    index_lines.append("")
    (out_dir / "INDEX.md").write_text("\n".join(index_lines), encoding="utf-8")

    summary = {
        "archiveCount": archive_count,
        "documentCount": len(documents),
        "documents": documents,
        "manuscript": manuscript_meta,
        "errors": errors[:40],
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
