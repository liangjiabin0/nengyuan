from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .text import XLSX_PRESETS, load_json, normalize_document_spec


def load_document_spec(path: str | Path | None = None, raw: str | None = None) -> dict[str, Any]:
    source_dir = Path(path).resolve().parent if path else None
    data = load_json(path, raw)
    return normalize_document_spec(data, source_dir=source_dir)


def normalize_workbook_spec(data: dict[str, Any]) -> dict[str, Any]:
    preset = str(data.get("preset") or "cn-workbook").strip() or "cn-workbook"
    if preset not in XLSX_PRESETS:
        raise ValueError(f"未知工作簿预设：{preset}，可选 {', '.join(XLSX_PRESETS)}")
    sheets = []
    raw_sheets = data.get("sheets") or []
    if not raw_sheets and (data.get("columns") or data.get("rows")):
        raw_sheets = [data]
    if not raw_sheets:
        raise ValueError("xlsx 规格至少需要一个 sheet")
    for index, sheet in enumerate(raw_sheets, start=1):
        if not isinstance(sheet, dict):
            continue
        columns = []
        for col in sheet.get("columns") or []:
            if isinstance(col, str):
                columns.append({"key": col, "title": col, "width": None, "format": "text", "formula": ""})
                continue
            key = str(col.get("key") or col.get("title") or f"col{len(columns)+1}")
            columns.append({
                "key": key,
                "title": str(col.get("title") or key),
                "width": col.get("width"),
                "format": str(col.get("format") or "text"),
                "formula": str(col.get("formula") or ""),
                "align": str(col.get("align") or ""),
            })
        rows = sheet.get("rows") or []
        dict_rows: list[dict[str, Any]] = []
        for row in rows:
            if isinstance(row, dict):
                dict_rows.append(row)
            else:
                mapped = {}
                for idx, col in enumerate(columns):
                    mapped[col["key"]] = row[idx] if idx < len(row) else ""
                dict_rows.append(mapped)
        if not columns and dict_rows:
            keys = list(dict_rows[0].keys())
            columns = [{"key": key, "title": key, "width": None, "format": "text", "formula": "", "align": ""} for key in keys]
        sheets.append({
            "name": str(sheet.get("name") or f"Sheet{index}")[:31],
            "freeze": sheet.get("freeze", "A2"),
            "filter": bool(sheet.get("filter", True)),
            "columns": columns,
            "rows": dict_rows,
            "notes": str(sheet.get("notes") or "").strip(),
            "charts": list(sheet.get("charts") or []),
            "totals": sheet.get("totals") or {},
        })
    return {
        "preset": preset,
        "title": str(data.get("title") or "").strip(),
        "author": str(data.get("author") or "").strip(),
        "sheets": sheets,
    }


def load_workbook_spec(path: str | Path | None = None, raw: str | None = None) -> dict[str, Any]:
    return normalize_workbook_spec(load_json(path, raw))


def normalize_csv_spec(data: dict[str, Any]) -> dict[str, Any]:
    columns = data.get("columns") or []
    columns = [str(item) for item in columns]
    rows = data.get("rows") or []
    dict_rows: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            dict_rows.append(row)
            if not columns:
                columns = list(row.keys())
        else:
            mapped = {columns[idx] if idx < len(columns) else f"col{idx+1}": value for idx, value in enumerate(row)}
            dict_rows.append(mapped)
            if not columns:
                columns = [f"col{idx+1}" for idx in range(len(row))]
    if not columns:
        raise ValueError("csv 规格缺少 columns 或 rows")
    encoding = str(data.get("encoding") or "utf-8-sig")
    if encoding not in {"utf-8-sig", "utf-8", "gbk"}:
        raise ValueError("csv encoding 只支持 utf-8-sig、utf-8、gbk")
    return {
        "encoding": encoding,
        "delimiter": str(data.get("delimiter") or ","),
        "columns": columns,
        "rows": dict_rows,
    }


def load_csv_spec(path: str | Path | None = None, raw: str | None = None) -> dict[str, Any]:
    return normalize_csv_spec(load_json(path, raw))


def normalize_deck_spec(data: dict[str, Any], *, source_dir: Path | None = None) -> dict[str, Any]:
    preset = str(data.get("preset") or "cn-business").strip() or "cn-business"
    if preset not in ("cn-report", "cn-business", "en-report", "memo"):
        raise ValueError(f"未知幻灯片预设：{preset}")
    slides_in = data.get("slides") or []
    if not slides_in:
        raise ValueError("pptx 规格至少需要 slides")
    slides = []
    for index, raw in enumerate(slides_in, start=1):
        if isinstance(raw, str):
            slides.append({
                "title": raw.strip(),
                "subtitle": "",
                "bullets": [],
                "notes": "",
                "figures": [],
            })
            continue
        if not isinstance(raw, dict):
            continue
        figures = []
        for item in raw.get("figures") or raw.get("images") or []:
            if isinstance(item, str):
                path = item
                caption = ""
            else:
                path = str(item.get("path") or item.get("src") or "").strip()
                caption = str(item.get("caption") or item.get("title") or "").strip()
            if path and source_dir and not Path(path).is_absolute():
                candidate = (source_dir / path).resolve()
                if candidate.exists():
                    path = str(candidate)
            if path:
                figures.append({"path": path, "caption": caption})
        bullets = raw.get("bullets") or raw.get("content") or raw.get("items") or []
        slides.append({
            "title": str(raw.get("title") or "").strip() or f"第{index}页",
            "subtitle": str(raw.get("subtitle") or "").strip(),
            "bullets": [str(item).strip() for item in bullets if str(item).strip()],
            "notes": str(raw.get("notes") or "").strip(),
            "figures": figures,
        })
    if not slides:
        raise ValueError("pptx 规格没有有效幻灯片")
    return {
        "preset": preset,
        "title": str(data.get("title") or slides[0]["title"]).strip(),
        "subtitle": str(data.get("subtitle") or "").strip(),
        "author": str(data.get("author") or "").strip(),
        "slides": slides,
    }


def load_deck_spec(path: str | Path | None = None, raw: str | None = None) -> dict[str, Any]:
    source_dir = Path(path).resolve().parent if path else None
    return normalize_deck_spec(load_json(path, raw), source_dir=source_dir)


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    source = text.replace("\r\n", "\n")
    if not source.startswith("---\n"):
        return {}, source
    end = source.find("\n---\n", 4)
    if end < 0:
        return {}, source
    header = source[4:end]
    body = source[end + 5:]
    meta: dict[str, Any] = {}
    for line in header.split("\n"):
        if not line.strip() or line.strip().startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if value.lower() in {"true", "yes"}:
            meta[key] = True
        elif value.lower() in {"false", "no"}:
            meta[key] = False
        else:
            meta[key] = value
    return meta, body


def markdown_to_spec(text: str, *, source_dir: Path | None = None) -> dict[str, Any]:
    meta, body = parse_frontmatter(text)
    lines = body.replace("\r\n", "\n").split("\n")
    sections: list[dict[str, Any]] = []
    current = {"heading": "", "level": 1, "blocks": []}
    references: list[str] = []
    in_refs = False
    i = 0
    paragraph_buf: list[str] = []

    def flush_paragraph() -> None:
        nonlocal paragraph_buf
        if not paragraph_buf:
            return
        text_block = "".join(paragraph_buf).strip()
        paragraph_buf = []
        if text_block:
            current["blocks"].append({"type": "paragraph", "text": text_block, "indent": True})

    def push_section(heading: str, level: int) -> None:
        nonlocal current, in_refs
        flush_paragraph()
        if current["heading"] or current["blocks"]:
            sections.append(current)
        current = {"heading": heading, "level": level, "blocks": []}
        in_refs = heading.replace(" ", "") in {"参考文献", "References", "参考资料"}

    while i < len(lines):
        line = lines[i]
        heading_match = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading_match:
            push_section(heading_match.group(2).strip(), len(heading_match.group(1)))
            i += 1
            continue
        if line.strip() == "$$":
            flush_paragraph()
            i += 1
            math_lines = []
            while i < len(lines) and lines[i].strip() != "$$":
                math_lines.append(lines[i])
                i += 1
            i += 1
            current["blocks"].append({"type": "equation", "latex": "\n".join(math_lines).strip()})
            continue
        if line.startswith("```"):
            flush_paragraph()
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].startswith("```"):
                code_lines.append(lines[i])
                i += 1
            i += 1
            current["blocks"].append({"type": "code", "text": "\n".join(code_lines)})
            continue
        if re.match(r"^!\[.*\]\(.+\)$", line.strip()):
            flush_paragraph()
            match = re.match(r"^!\[(.*)\]\((.+)\)$", line.strip())
            assert match
            current["blocks"].append({
                "type": "figure",
                "path": match.group(2).strip(),
                "caption": match.group(1).strip(),
            })
            i += 1
            continue
        if line.strip() == "---":
            flush_paragraph()
            current["blocks"].append({"type": "pagebreak"})
            i += 1
            continue
        if "|" in line and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{3,}", lines[i + 1]):
            flush_paragraph()
            header_line = line
            i += 2
            body_rows = []
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                body_rows.append(lines[i])
                i += 1
            headers = _split_md_row(header_line)
            rows = [_split_md_row(row) for row in body_rows]
            title = ""
            if current["blocks"] and current["blocks"][-1]["type"] == "paragraph":
                maybe = current["blocks"][-1]["text"]
                if re.match(r"^(表|Table)\s*\d+", maybe):
                    title = maybe
                    current["blocks"].pop()
            current["blocks"].append({"type": "table", "title": title, "headers": headers, "rows": rows, "style": "three-line"})
            continue
        list_match = re.match(r"^(\s*)([-*]|\d+[.)])\s+(.+)$", line)
        if list_match:
            flush_paragraph()
            ordered = bool(re.match(r"\d+", list_match.group(2)))
            items = [list_match.group(3).strip()]
            i += 1
            while i < len(lines):
                more = re.match(r"^(\s*)([-*]|\d+[.)])\s+(.+)$", lines[i])
                if not more:
                    break
                items.append(more.group(3).strip())
                i += 1
            current["blocks"].append({"type": "list", "ordered": ordered, "items": items})
            continue
        if not line.strip():
            flush_paragraph()
            i += 1
            continue
        if in_refs:
            flush_paragraph()
            stripped = re.sub(r"^\[\d+\]\s*", "", line.strip())
            if stripped:
                references.append(stripped)
            i += 1
            continue
        paragraph_buf.append(line.strip())
        i += 1
    flush_paragraph()
    if current["heading"] or current["blocks"]:
        sections.append(current)
    spec = {
        "preset": meta.get("preset") or "cn-report",
        "title": meta.get("title") or (sections[0]["heading"] if sections else ""),
        "subtitle": meta.get("subtitle") or "",
        "author": meta.get("author") or "",
        "org": meta.get("org") or "",
        "date": meta.get("date") or "",
        "toc": meta.get("toc", True),
        "header": meta.get("header") or "",
        "footer": meta.get("footer") or "",
        "sections": sections if (len(sections) > 1 or (sections and sections[0]["heading"])) else [{"heading": "", "level": 1, "blocks": sections[0]["blocks"] if sections else []}],
        "references": references or [str(item) for item in ([meta["references"]] if isinstance(meta.get("references"), str) else (meta.get("references") or []))],
    }
    return normalize_document_spec(spec, source_dir=source_dir)


def load_markdown_spec(path: str | Path) -> dict[str, Any]:
    file = Path(path)
    return markdown_to_spec(file.read_text(encoding="utf-8-sig"), source_dir=file.parent)


def _split_md_row(line: str) -> list[str]:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return cells
