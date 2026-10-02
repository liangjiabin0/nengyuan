#!/usr/bin/env python3
"""Validate that a prompt pack includes the non-negotiable template and evidence rules."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


REQUIRED = {
    "aspect_ratio": "16:9",
    "template_lock": "不可变区域",
    "page_number_lock": "页码位置",
    "source_fidelity": "不得编造",
    "editable_intent": "可编辑PPT对象",
    "formula_font": "Cambria Math",
    "scalar_style": "标量斜体",
    "vector_style": "加粗斜体",
    "office_math": "Office数学公式对象",
    "no_overlap": "禁止文字重叠",
    "controlled_icons": "electrical-icons 白名单",
    "no_generated_icons": "图像模型不得自行绘制",
    "green_primary": "以绿色为主色",
    "color_budget": "最多三种有彩色",
    "no_rainbow": "禁止彩虹式配色",
    "upper_text_lower_visual": "上方文本、下方配图",
    "formula_reserved_frame": "预留清洁、宽阔的原生公式区域",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt_pack", type=Path)
    args = parser.parse_args()
    text = args.prompt_pack.read_text(encoding="utf-8")
    missing = [name for name, phrase in REQUIRED.items() if phrase not in text]
    slide_ids = re.findall(r"^=== SLIDE\s+(\d+)\s+===$", text, flags=re.M)
    duplicated = sorted({value for value in slide_ids if slide_ids.count(value) > 1})
    errors = []
    if missing:
        errors.append("missing required rules: " + ", ".join(missing))
    if not slide_ids:
        errors.append("no per-slide prompts found")
    if duplicated:
        errors.append("duplicate slide ids: " + ", ".join(duplicated))
    for slide_id in slide_ids:
        block = re.search(
            rf"^=== SLIDE\s+{re.escape(slide_id)}\s+===$(.+?)(?=^=== SLIDE|\Z)",
            text,
            flags=re.M | re.S,
        )
        if block:
            for required in ["页面核心结论：", "映射模板源页：", "来源定位：", "视觉验收："]:
                if required not in block.group(1):
                    errors.append(f"slide {slide_id} missing {required}")
    if errors:
        print("FAIL")
        for error in errors:
            print("- " + error)
        raise SystemExit(1)
    print(f"PASS: {len(slide_ids)} slide prompt(s)")


if __name__ == "__main__":
    main()
