#!/usr/bin/env python3
"""Validate production-facing dense Markdown summaries.

This checker intentionally validates only deterministic production contracts.
Formula/source equivalence must be recorded and approved by the extraction
pipeline before a formula is allowed into production.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


HEADINGS = {
    "论文": ("研究问题与总体思路", "核心理论与方法", "技术实现流程", "实验与关键结果", "核心创新与局限"),
    "专利": ("要解决的技术问题", "核心技术方案", "关键技术机制", "权利要求与保护核心", "技术效果与局限"),
    "标准": ("适用范围与检测对象", "核心技术要求", "主要检测项目与方法", "关键参数与判定", "抽样、复检与记录"),
    "目录索引": ("文件性质与收录范围", "分类结构与检索入口", "与本项目直接相关的条目", "可提供的线索与不可提供的证据", "后续取全文和核验要求"),
}

FORBIDDEN = tuple(re.compile(pattern, re.I) for pattern in (
    r"(?:KI|PAR|RL|RS|FT|MC|MTH|TMEE)-P2-",
    r"\b(?:Gold|Silver|Insight|Hold|SOURCE|INFERENCE|PASS_WITH_LIMITATION)\b",
    r"\bL[123]\b|Quality Gate|Coverage Manifest|OCR Provenance|AI_VISUAL|SimpleTex",
    r"Evidence Index|Evidence Level|Evidence JSON|次级追踪ID",
    r"source_location|knowledge_id|result_id|rule_id|feature_id",
    r"从文本中稳定识别|结论段未被稳定识别|以题名及正文对象为准",
    r"原PDF|重新核对|生成过程|数据库字段|抽取记录",
))

UNICODE_MATH = re.compile(r"[₀-₉⁰-⁹≤≥≠∑∏√∞∈∉⊂⊆∪∩→←↔]")
EMPTY_SCRIPT = re.compile(r"[_^]\s*\{\s*\}")


def math_segments(markdown: str) -> list[str]:
    segments: list[str] = []
    index = 0
    while index < len(markdown):
        if markdown.startswith("$$", index):
            end = markdown.find("$$", index + 2)
            if end < 0:
                raise ValueError("未闭合的块级公式分隔符")
            segments.append(markdown[index + 2:end])
            index = end + 2
        elif markdown[index] == "$" and (index == 0 or markdown[index - 1] != "\\"):
            end = index + 1
            while True:
                end = markdown.find("$", end)
                if end < 0:
                    raise ValueError("未闭合的行内公式分隔符")
                if markdown[end - 1] != "\\":
                    break
                end += 1
            segments.append(markdown[index + 1:end])
            index = end + 1
        else:
            index += 1
    return segments


def check_formula_syntax(text: str) -> list[str]:
    errors: list[str] = []
    try:
        formulas = math_segments(text)
    except ValueError as exc:
        return [str(exc)]
    for formula in formulas:
        if not formula.strip():
            errors.append("存在空公式")
        if UNICODE_MATH.search(formula):
            errors.append(f"公式内含 Unicode 伪数学字符：{formula[:80]}")
        if EMPTY_SCRIPT.search(formula):
            errors.append(f"公式内有空上下标：{formula[:80]}")
        if formula.count("{") != formula.count("}"):
            errors.append(f"公式花括号不平衡：{formula[:80]}")
        if formula.count(r"\left") != formula.count(r"\right"):
            errors.append(f"公式 left/right 不平衡：{formula[:80]}")
    return errors


def detect_type(path: Path, text: str, manifest_type: str | None) -> str | None:
    if manifest_type in HEADINGS:
        return manifest_type
    if "权利要求与保护核心" in text:
        return "专利"
    if "关键参数与判定" in text:
        return "标准"
    if "实验与关键结果" in text:
        return "论文"
    if "文件性质与收录范围" in text:
        return "目录索引"
    return None


def validate(path: Path, resource_type: str | None, relaxed_length: bool) -> list[str]:
    text = path.read_text(encoding="utf-8")
    errors: list[str] = []
    kind = detect_type(path, text, resource_type)
    if not kind:
        errors.append("无法识别文种模板")
        return errors
    if len(re.findall(r"^# ", text, re.M)) != 1:
        errors.append("必须且只能有一个一级题名")
    if not re.match(r"(?s)^# .+?\n\n> \*\*核心结论：\*\* .+?\n\n## 1\.", text):
        errors.append("题名后必须立即给出核心结论")
    actual = tuple(re.findall(r"^## \d+\. (.+)$", text, re.M))
    if actual != HEADINGS[kind]:
        errors.append(f"五段标题不符合{kind}模板：{actual}")
    if "一句话总结" in text:
        errors.append("不得保留结尾一句话总结")
    chinese_count = len(re.findall(r"[\u4e00-\u9fff]", text))
    limited_source = "本地仅有短文本" in text or "未取得标准全文" in text
    if kind != "目录索引" and not limited_source and not relaxed_length and chinese_count < 1400:
        errors.append(f"中文字符数 {chinese_count} 少于 1400")
    leaked = [pattern.pattern for pattern in FORBIDDEN if pattern.search(text)]
    if leaked:
        errors.append(f"含生产禁用字段/占位语：{leaked}")
    errors.extend(check_formula_syntax(text))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path, help="单个 Markdown 或摘要目录")
    parser.add_argument("--type", choices=tuple(HEADINGS), dest="resource_type")
    parser.add_argument("--relaxed-length", action="store_true")
    args = parser.parse_args()
    files = [args.path] if args.path.is_file() else sorted(args.path.glob("*.md"))
    if not files:
        print("未找到 Markdown", file=sys.stderr)
        return 2
    failed = 0
    for path in files:
        errors = validate(path, args.resource_type, args.relaxed_length)
        if errors:
            failed += 1
            print(f"FAIL {path}")
            for error in errors:
                print(f"  - {error}")
        else:
            print(f"PASS {path}")
    print(f"checked={len(files)} passed={len(files)-failed} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
