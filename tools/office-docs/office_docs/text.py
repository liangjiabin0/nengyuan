from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

PRESETS = ("cn-report", "cn-business", "en-report", "memo")
XLSX_PRESETS = ("cn-workbook", "data-export")

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
ASCII_CHUNK_RE = re.compile(
    r"([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[^ \u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)"
)


def load_json(path: str | Path | None, raw: str | None = None) -> dict[str, Any]:
    if raw is not None:
        text = raw
    elif path:
        text = Path(path).read_text(encoding="utf-8-sig")
    else:
        raise ValueError("需要 --spec 或 --markdown")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("规格必须是 JSON 对象")
    return data


def normalize_document_spec(data: dict[str, Any], *, source_dir: Path | None = None) -> dict[str, Any]:
    preset = str(data.get("preset") or "cn-report").strip() or "cn-report"
    if preset not in PRESETS:
        raise ValueError(f"未知文档预设：{preset}，可选 {', '.join(PRESETS)}")
    sections = data.get("sections")
    blocks = data.get("blocks")
    if not sections:
        sections = [{"heading": "", "level": 1, "blocks": list(blocks or [])}]
    normalized_sections = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        heading = str(section.get("heading") or "").strip()
        level = int(section.get("level") or 1)
        level = min(max(level, 1), 3)
        item_blocks = [normalize_block(block, source_dir) for block in section.get("blocks") or []]
        normalized_sections.append({"heading": heading, "level": level, "blocks": item_blocks})
    return {
        "preset": preset,
        "title": str(data.get("title") or "").strip(),
        "subtitle": str(data.get("subtitle") or "").strip(),
        "author": str(data.get("author") or "").strip(),
        "org": str(data.get("org") or "").strip(),
        "date": str(data.get("date") or "").strip(),
        "toc": bool(data.get("toc", True if preset in {"cn-report", "en-report"} else False)),
        "header": str(data.get("header") or data.get("title") or "").strip(),
        "footer": str(data.get("footer") or "").strip(),
        "page_numbers": bool(data.get("page_numbers", True)),
        "confidential": bool(data.get("confidential", False)),
        "sections": normalized_sections,
        "references": [str(item).strip() for item in (data.get("references") or []) if str(item).strip()],
    }


def normalize_block(block: Any, source_dir: Path | None) -> dict[str, Any]:
    if isinstance(block, str):
        return {"type": "paragraph", "text": block, "indent": True}
    if not isinstance(block, dict):
        raise ValueError("block 必须是对象或字符串")
    kind = str(block.get("type") or "paragraph").strip().lower()
    if kind in {"p", "para", "text"}:
        kind = "paragraph"
    if kind == "paragraph":
        return {
            "type": "paragraph",
            "text": str(block.get("text") or ""),
            "indent": bool(block.get("indent", True)),
        }
    if kind == "list":
        items = block.get("items") or []
        return {
            "type": "list",
            "ordered": bool(block.get("ordered", False)),
            "items": [str(item) for item in items],
        }
    if kind == "table":
        headers = [str(item) for item in (block.get("headers") or [])]
        rows = []
        for row in block.get("rows") or []:
            if isinstance(row, dict):
                rows.append([row.get(key, "") for key in headers])
            else:
                rows.append([cell if cell is not None else "" for cell in row])
        return {
            "type": "table",
            "title": str(block.get("title") or "").strip(),
            "headers": headers,
            "rows": rows,
            "style": str(block.get("style") or "three-line"),
            "align": list(block.get("align") or []),
        }
    if kind in {"figure", "image"}:
        path = str(block.get("path") or block.get("src") or "").strip()
        if path and source_dir and not Path(path).is_absolute():
            candidate = (source_dir / path).resolve()
            if candidate.exists():
                path = str(candidate)
        return {
            "type": "figure",
            "path": path,
            "caption": str(block.get("caption") or block.get("title") or "").strip(),
            "width_cm": float(block.get("width_cm") or 14),
        }
    if kind in {"equation", "formula"}:
        return {
            "type": "equation",
            "latex": str(block.get("latex") or block.get("text") or "").strip(),
            "number": str(block.get("number") or "").strip(),
        }
    if kind in {"quote", "callout", "note"}:
        return {"type": "quote", "text": str(block.get("text") or "")}
    if kind == "pagebreak":
        return {"type": "pagebreak"}
    if kind == "code":
        return {"type": "code", "text": str(block.get("text") or "")}
    raise ValueError(f"不支持的 block 类型：{kind}")


def split_cjk_ascii(text: str) -> list[tuple[str, bool]]:
    """Return (chunk, is_cjk) pairs for dual-font runs."""
    if not text:
        return []
    parts: list[tuple[str, bool]] = []
    for chunk in ASCII_CHUNK_RE.findall(text):
        if not chunk:
            continue
        parts.append((chunk, bool(CJK_RE.fullmatch(chunk))))
    return parts or [(text, bool(CJK_RE.search(text)))]


def escape_xml(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
