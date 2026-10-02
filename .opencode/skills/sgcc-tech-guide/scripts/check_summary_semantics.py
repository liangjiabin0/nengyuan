from __future__ import annotations

import argparse
import re
from pathlib import Path


BAD_PHRASES = (
    "从文本中稳定识别", "结论段未被稳定识别", "资助协议号", "荷兰版权法",
    "中 国 电 机 工 程 学 报", "电 工 技 术 学 报", "所提出的方法的有效性不会",
    "本文提出了提出", "图图", "供稿中",
)
PRODUCTION_FIELDS = re.compile(r"\b(?:Gold|Silver|Insight|Hold|SOURCE|INFERENCE|PASS_WITH_LIMITATION|Quality Gate)\b", re.I)


def latin_ratio(text: str) -> float:
    text = re.sub(r"\$[^$]+\$", "", text)
    text = re.sub(r"\\[A-Za-z]+", "", text)
    latin = len(re.findall(r"[A-Za-z]", text))
    chinese = len(re.findall(r"[\u3400-\u9fff]", text))
    return latin / max(1, latin + chinese)


def sections(text: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"^## (.+)$", text, re.M))
    output = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        output.append((match.group(1), text[match.end():end].strip()))
    return output


def check(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    issues = []
    core = re.search(r"^> \*\*核心结论：\*\*\s*(.+)$", text, re.M)
    if not core:
        issues.append("缺少文首核心结论")
    else:
        value = core.group(1)
        if latin_ratio(value) > 0.18:
            issues.append("核心结论仍以英文/拉丁正文为主")
        if len(re.findall(r"[\u3400-\u9fff]", value)) < 55:
            issues.append("核心结论技术信息不足")
    found = sections(text)
    headings = [heading for heading, _ in found]
    if any("权利要求" in heading for heading in headings):
        doc_type, min_chars, max_latin = "patent", 45, 0.30
    elif any("关键参数与判定" in heading for heading in headings):
        doc_type, min_chars, max_latin = "standard", 25, 0.42
    elif any("文件性质与收录范围" in heading for heading in headings):
        doc_type, min_chars, max_latin = "index", 25, 0.85
    else:
        doc_type, min_chars, max_latin = "paper", 100, 0.25
    if len(found) != 5:
        issues.append(f"应有5个专项章节，实际{len(found)}个")
    for heading, body in found:
        if latin_ratio(body) > max_latin:
            issues.append(f"章节仍以英文/拉丁正文为主：{heading}")
        if len(re.findall(r"[\u3400-\u9fff]", body)) < min_chars:
            issues.append(f"章节技术信息不足：{heading}")
    for phrase in BAD_PHRASES:
        if phrase in text:
            issues.append(f"含解析/OCR噪声：{phrase}")
    if doc_type == "paper" and re.search(r"(?:^|\s)图\s*\d+[:：]?[^。]{100,}", text):
        issues.append("疑似整段图注或页面文本拼接")
    if PRODUCTION_FIELDS.search(text):
        issues.append("含后台分层或门禁字段")
    return issues


def main() -> None:
    parser = argparse.ArgumentParser(description="检查高密度单篇总结的语义质量和生产文本纯净度")
    parser.add_argument("path", type=Path, help="单个Markdown或总结目录")
    args = parser.parse_args()
    paths = [args.path] if args.path.is_file() else sorted(args.path.glob("*.md"))
    failed = 0
    for path in paths:
        issues = check(path)
        if issues:
            failed += 1
            print(f"FAIL {path}")
            for issue in issues:
                print(f"  - {issue}")
        else:
            print(f"PASS {path}")
    print(f"checked={len(paths)} passed={len(paths) - failed} failed={failed}")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
