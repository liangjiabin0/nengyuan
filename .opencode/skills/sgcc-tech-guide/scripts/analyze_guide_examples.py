#!/usr/bin/env python3
"""Select the latest SGCC headquarters guide and extract a reusable style baseline."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from pypdf import PdfReader


DEFAULT_KEYWORDS = [
    "主配", "配微", "微电网", "配电网", "协同规划", "运行仿真",
    "状态估计", "坏数据", "拓扑错误", "调节能力", "安全校核",
]


def normalize(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class Candidate:
    path: Path
    guide_year: int
    release_date: str
    cover_text: str
    page_count: int

    @property
    def sort_key(self) -> tuple[int, str, float]:
        return self.guide_year, self.release_date, self.path.stat().st_mtime


def parse_release_date(text: str, fallback_year: int) -> str:
    patterns = [
        r"(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?",
        r"(20\d{2})\s*[年./-]\s*(\d{1,2})\s*月?",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        parts = [int(value) for value in match.groups()]
        if len(parts) == 3:
            return f"{parts[0]:04d}-{parts[1]:02d}-{parts[2]:02d}"
        return f"{parts[0]:04d}-{parts[1]:02d}-01"
    return f"{fallback_year:04d}-01-01"


def inspect_candidate(path: Path) -> Candidate | None:
    if "指南" not in path.name or "总部科技" not in path.name:
        return None
    reader = PdfReader(str(path))
    cover_text = normalize("\n".join((page.extract_text() or "") for page in reader.pages[:3]))
    match = re.search(r"国家电网公司\s*(20\d{2})\s*年", compact(cover_text))
    if match:
        year = int(match.group(1))
    else:
        years = [int(value) for value in re.findall(r"20\d{2}", path.name)]
        if not years:
            return None
        year = max(years)
    release_date = parse_release_date(cover_text + " " + path.name, year)
    return Candidate(path, year, release_date, cover_text, len(reader.pages))


def extract_pages(path: Path) -> list[dict[str, object]]:
    reader = PdfReader(str(path))
    pages: list[dict[str, object]] = []
    for page_no, page in enumerate(reader.pages, start=1):
        text = normalize(page.extract_text() or "")
        pages.append({"page": page_no, "chars": len(text), "text": text})
    return pages


PROJECT_RE = re.compile(
    r"项\s*目\s*(\d+)\s*[：:]\s*《(.{1,180}?)》\s*项\s*目\s*(?:申\s*报\s*指\s*南|指\s*南\s*申\s*报)",
    re.S,
)


def find_projects(pages: list[dict[str, object]]) -> list[dict[str, object]]:
    starts: list[dict[str, object]] = []
    for item in pages:
        text = str(item["text"])
        if "一、学科、根技术" not in text:
            continue
        match = PROJECT_RE.search(text)
        if not match:
            continue
        title = re.sub(r"\s+", "", match.group(2))
        starts.append({"project_no": int(match.group(1)), "title": title, "start_page": item["page"]})
    starts.sort(key=lambda item: int(item["start_page"]))
    for index, item in enumerate(starts):
        next_start = int(starts[index + 1]["start_page"]) if index + 1 < len(starts) else len(pages) + 1
        item["end_page"] = next_start - 1
    return starts


def project_text(project: dict[str, object], pages: list[dict[str, object]]) -> str:
    start, end = int(project["start_page"]), int(project["end_page"])
    return "\n".join(str(item["text"]) for item in pages if start <= int(item["page"]) <= end)


def build_report(candidate: Candidate, candidates: list[Candidate], pages: list[dict[str, object]], projects: list[dict[str, object]], keywords: list[str]) -> str:
    relevant = []
    for project in projects:
        content = project_text(project, pages)
        matched = [word for word in keywords if word in content]
        if matched:
            relevant.append((project, matched))

    section_names = [
        "一、学科、根技术", "二、应用场景、功能需求及关键技术", "三、课题内容",
        "四、技术成熟度及成果应用", "五、项目实施期限", "六、支持经费限额", "七、牵头单位",
    ]
    full_text = "\n".join(str(item["text"]) for item in pages)
    lines = [
        "# 最新国网范例写作基线（自动提取草稿）",
        "",
        f"- 最新范例：`{candidate.path}`",
        f"- 指南年度：{candidate.guide_year}",
        f"- 发布日期线索：{candidate.release_date}",
        f"- PDF 页数：{candidate.page_count}",
        f"- SHA-256：`{sha256(candidate.path)}`",
        f"- 自动识别到正式项目正文：{len(projects)} 项",
        "",
        "> 本文件是定位辅助结果。自动项目数仅用于完整性预警，不替代目录核数。必须人工完整阅读相关项目，核对页面图像和发布信息后，才能作为当次正式写作基线。",
        "",
        "## 候选范例排序",
        "",
    ]
    for item in sorted(candidates, key=lambda value: value.sort_key, reverse=True):
        lines.append(f"- {item.guide_year} / {item.release_date} / {item.page_count}页 / `{item.path}`")
    lines.extend(["", "## 七段结构出现次数", ""])
    for name in section_names:
        lines.append(f"- {name}：{full_text.count(name)}")
    lines.extend(["", "## 与关键词相关的项目", ""])
    for project, matched in relevant:
        lines.append(
            f"- 项目{project['project_no']}《{project['title']}》：PDF第{project['start_page']}-{project['end_page']}页；关键词：{'、'.join(matched)}"
        )
    lines.extend([
        "", "## 人工提炼要求", "",
        "1. 从相关项目逐项提取应用场景的背景、既有做法、具体问题、工程后果和应用对象。",
        "2. 对照功能需求与关键技术，检查是否以业务能力起笔、是否与课题一一对应。",
        "3. 记录每个课题的研究对象、递进动作、成果形态、指标结构和成熟度环境。",
        "4. 建立相近指南重复边界；不得只比较标题，也要比较对象、输入输出、方法和成果。",
        "5. 范例中的模糊阈值或不可验收写法不得照搬。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True, type=Path, help="Directory containing SGCC guide PDFs")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--keywords", nargs="*", default=DEFAULT_KEYWORDS)
    args = parser.parse_args()

    candidates = []
    for path in args.input_dir.rglob("*.pdf"):
        try:
            candidate = inspect_candidate(path)
        except Exception as exc:  # keep inventorying other guides
            print(f"WARN: cannot inspect {path}: {exc}")
            continue
        if candidate:
            candidates.append(candidate)
    if not candidates:
        raise SystemExit("No headquarters technology guide PDF found")

    latest = max(candidates, key=lambda item: item.sort_key)
    pages = extract_pages(latest.path)
    projects = find_projects(pages)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": str(latest.path),
        "guide_year": latest.guide_year,
        "release_date_hint": latest.release_date,
        "page_count": latest.page_count,
        "sha256": sha256(latest.path),
        "projects": projects,
        "pages": pages,
    }
    (args.output_dir / "latest_guide_fulltext.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.output_dir / "latest_guide_fulltext.txt").write_text(
        "\n\n".join(f"===== PDF PAGE {item['page']} =====\n{item['text']}" for item in pages),
        encoding="utf-8",
    )
    report = build_report(latest, candidates, pages, projects, args.keywords)
    (args.output_dir / "latest_guide_style_baseline.md").write_text(report, encoding="utf-8")
    print(json.dumps({
        "latest": str(latest.path),
        "year": latest.guide_year,
        "pages": latest.page_count,
        "projects": len(projects),
        "output": str(args.output_dir),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
