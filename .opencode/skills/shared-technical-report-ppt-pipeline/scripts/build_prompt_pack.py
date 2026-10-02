#!/usr/bin/env python3
"""Build a global image prompt and ordered per-slide prompts from content-plan JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


GLOBAL_PROMPT = """【固定科研PPT母版与内容规则——全页通用】
生成16:9横版PPT页面预览图，严格继承用户提供的最新模板或参考图。若无更新的视觉模板，以 green-technical-report-style 为默认：白色或极浅青绿色背景，左上深绿色章节标题，约13%高度处一条细绿色分隔线，右上仅保留来源明确的机构Logo，正文页码固定在右下。标题基线、页眉、分隔线、Logo安全区和页码位置均为不可变区域；只替换标题、页码和正文安全区内容。不得重新设计母版，不得增加章节编号、额外Logo、城市天际线、波浪页脚或重复页码。

中文使用微软雅黑，普通英文与数字沿用模板字体，原生数学公式默认使用Cambria Math。整体以绿色为主色，配白色和中性灰；普通页面只使用一个绿色色系，含图表系列在内最多三种有彩色。优先用绿色明度、线型、标记和直接标注区分类别，禁止彩虹式配色、五颜六色图标以及无关的蓝橙紫堆叠。红色仅用于一处有来源支撑的关键结论或风险提示，不作为通用装饰色。整体保持大气、简洁、统一的科研汇报风格。

内容页默认采用“上方文本、下方配图”的单一大构图：上方约25%—35%放3—5行总结性文字，下方约46%—50%放一幅主图、两幅并列证据图或图表组合。不要拆成密集卡片墙。公式为主的页面在中部预留清洁、宽阔的原生公式区域，预览图只表现公式占位边界与层级，不让图像模型承担公式正确性。

只使用证据清单中提供的结论、数字、公式、表格和图片。不得编造数值、比例、刻度、容量、效率、价格、成本或结论。复杂插图与正文保持独立，后续须可单独替换；标题、正文、图表、图例、坐标轴、卡片、边框、箭头和页码均按可编辑PPT对象设计。

电气、能源、数据、计算、汽车、储电、放电、预测、光伏、风力、电网、市场和风险类图标，只能从本地 electrical-icons 白名单中选择。图像模型不得自行绘制、改造或添加图标；预览中先保留准确的图标位置和尺寸，再叠加白名单中的原始SVG，最终PPT必须插入同一SVG。除用户提供或源模板、参考图中已有并记录来源的图标外，禁止使用其他图标。

公式必须保持完整的变量、上下标、分式、求和、矩阵、函数和编号。标量斜体，矢量与矩阵加粗斜体，描述性上下标和函数名正体。公式整体使用深绿色或近黑色，不给不同变量任意上色。预览图不得显示LaTeX源码、反斜杠、下划线或插入符号；最终PPT使用Cambria Math原生Office数学公式对象，并通过公式清单与PPTX包结构双重校验。

禁止文字重叠、标题换行、箭头穿过文字、公式裁切、图片变形、空白占位符、无意义大面积留白和密集卡片墙。"""


FRAME_TEXT = {
    1: "使用封面结构：主标题居中或左中布置，信息区保持克制，使用浅绿色大色面和单一主视觉。",
    2: "使用公式/技术内容结构：标题带y=0.04–0.105；上方说明至y≈0.29；中部公式框x=0.08–0.92、y=0.31–0.62；下方变量与约束至y≈0.88。",
    3: "使用上文下图结构：标题带y=0.04–0.105；总结文字x=0.032–0.968、y=0.16–0.44；下方一幅主图或左右两幅证据图x=0.045–0.955、y=0.47–0.93。",
}


def lines(items: list[str], prefix: str = "- ") -> str:
    return "\n".join(f"{prefix}{item}" for item in items) if items else "- 无"


def build_slide_prompt(slide: dict) -> str:
    visuals = []
    for visual in slide.get("visuals", []):
        placement = f"；位置：{visual['placement']}" if visual.get("placement") else ""
        visuals.append(
            f"{visual['type']}｜来源：{visual['source']}｜作用：{visual['purpose']}{placement}"
        )
    formulas = slide.get("formulaIds", [])
    negatives = slide.get("negativeConstraints", [])
    return f"""=== SLIDE {slide['page']} ===
页面大标题：{slide['title']}
页面小标题：{slide['subtitle']}
页码：{slide['page']}
页面核心结论：{slide['takeaway']}
映射模板源页：{slide['sourceSlide']}
版式类型：{slide['layout']}
坐标与结构：{FRAME_TEXT[int(slide['sourceSlide'])]}

正文内容：
{lines(slide.get('content', []))}

配图、图表与公式：
{lines(visuals)}

公式清单：
{lines(formulas)}

来源定位：
{lines(slide.get('sourceRefs', []))}

本页额外禁止项：
{lines(negatives)}

视觉验收：固定母版不得漂移；标题保持单行；正文不进入页眉和页脚；图文层级清楚；所有图表与公式可读；不得出现未经来源支持的内容。"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("content_plan", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    plan = json.loads(args.content_plan.read_text(encoding="utf-8"))
    slides = sorted(plan["slides"], key=lambda item: item["page"])
    text = [GLOBAL_PROMPT, "", "【逐页提示词】", ""]
    for slide in slides:
        text.extend([build_slide_prompt(slide), ""])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(text).rstrip() + "\n", encoding="utf-8")
    print(args.output.resolve())


if __name__ == "__main__":
    main()
