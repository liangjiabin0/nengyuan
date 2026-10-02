---
name: shared-two-slide-paper-ppt-codegen
title: "PPT（学术论文版）"
description: Read a power-system planning or forecasting paper, extract its method and results, and directly build a two-slide editable academic PPT. Use for a planning model/solver plus economic and computational results, or a forecasting computation flow plus accuracy, ablation, and robustness results.
---

## 能元服务器运行环境

此技能已接入能元 OpenCode。文件目录以本 SKILL.md 所在目录为准，不使用开发者电脑的绝对路径。用系统 office-docs/pdf 工具读取源资料，用仓库 Node 与 pptxgenjs 构建，用 LibreOffice 渲染并检查每页。私有 Python 默认 tools/office-docs-venv/bin/python（Windows 对应 Scripts/python.exe），可用 OFFICE_DOCS_PYTHON 覆盖。参考样例在 assets/reference-pptx，原提示词和证据规则仍适用。没有配置外部 Codex runtime 时，不执行 artifact-tool 专用脚本。


# Two-slide paper PPT codegen

Read the source document, design two audience-ready slides, and directly create the editable PPTX. Do not modify `technical-report-ppt-pipeline`.

The production path is document → evidence and method logic → slide design → editable PPTX → final quality check. Do not generate image-generation prompts, slide preview drafts, or reference-image reconstruction scripts. Do not require preview approval before building the PPTX. Rendering an exported PPTX for final quality inspection is a verification step, not a preview-design stage.

## Workflow

1. Read the complete source document with the appropriate PDF or Documents skill. Inspect method sections, diagrams, equations, result tables, captions, and limitations together. Extract only the source figures needed as evidence.
2. Inspect a supplied editable template or sample PPTX. When using this skill's bundled examples, planning papers should reference the PPTX files in [assets/reference-pptx/规划类](assets/reference-pptx/规划类), and forecasting papers should reference those in [assets/reference-pptx/预测类](assets/reference-pptx/预测类). In the selected deck, slide 1 guides the paper's principle/method slide; slide 2 guides the case-study/experimental-results slide. Reuse the relevant slide ratio, background, title system, margins, summary box, colors, and visual hierarchy. If neither supplied nor bundled references fit the paper, use a 16:9 blue/teal academic theme.
3. Classify the paper by its main research question, not by a word in its title. For prediction, read [references/forecasting-paper.md](references/forecasting-paper.md), reconstruct `method-graph.json` following [references/method-graph-workflow.md](references/method-graph-workflow.md), and run `scripts/validate_method_graph.py`. For planning, read [references/planning-paper.md](references/planning-paper.md) and record the model, decision hierarchy, coupling, and solver loop in `planning-model.md`. A planning solver is not a prediction training graph. For mixed papers, use the branch that reflects the main contribution and retain the other as supporting evidence.
4. Design the two slides directly from the documented method and evidence. Record the layout, hierarchy, object positions, connector paths, and formula placement in `visual-design-spec.md`. Choose a layout that explains the method; do not copy source-image pixel geometry.
5. Build a content spec following [references/two-slide-spec.md](references/two-slide-spec.md), plus `source-index.json` and `evidence-ledger.json`. Record source locations for all claims, formulas, relationships, and numerical data. Validate the content spec with `scripts/validate_two_slide_spec.py`.
6. Use the server-supported native PPTX builder (PptxGenJS) for the main build; the external Codex Presentations runtime is optional. Reuse helpers from `scripts/build_two_slide_deck.mjs` where appropriate, or create a task-specific builder. The starter has fixed 1280×720 geometry, three method panels, and two charts plus a table; it does not automatically import a template or draw the method graph. Adapt the builder to the paper type, template, and content rather than forcing its starter layout.
7. Draw text, module boxes, connectors, tables, and data-backed charts as native PowerPoint objects. Place formulas beside their operations. When formulas are present, follow [references/formula-svg-workflow.md](references/formula-svg-workflow.md) and retain canonical LaTeX plus `formula-manifest.json` for revision.
8. Export the PPTX, run `scripts/audit_visible_pptx.py` and the Presentations package/layout checks, then inspect a rendering of every final slide. Fix clipping, overlaps, unreadable labels, misplaced arrows, missing equations, and chart errors. Confirm text, shapes, tables, and charts remain editable. Verify SVG equations with PowerPoint rendering because some secondary renderers omit them.

When slide 2 contains comparison curves, read [references/result-chart-style.md](references/result-chart-style.md). Use `scripts/apply_result_chart_style.ps1` when native PowerPoint line charts need style repair.

## Slide contract

- Slide 1: paper-specific method title, a left-aligned summary of at most two lines, and a diagram with adjacent formulas. Forecasting usually needs an integrated input-to-output computation flow; planning usually needs a decision architecture, objective/constraints, and solver flow. Follow the relevant branch reference rather than imposing either layout on every paper.
- Slide 2: direct result title, a left-aligned two-line conclusion, and three parallel **evidence themes**. Each theme may contain one or two aligned charts, a table, a topology diagram, a trace, or a compact explanation. Three themes do not mean exactly three charts. Select the themes from the paper's actual experiments; never invent data to fill a region.
- Keep each bottom conclusion to two lines or fewer. Use the supplied slide ratio, otherwise 16:9.
- Colored labels and their text must share the same geometry. Do not place a shorter text box over a longer colored label background.

## Editability

- Use real text boxes, native shapes and connectors, native tables, and native charts with embedded editable data. Never flatten a whole slide, method diagram, or table into an image.
- Lay out diagrams from semantic nodes and edges. Use explicit connector endpoints and waypoints where necessary to keep relationships unambiguous.
- Preserve source photographs, maps, heatmaps, and complex experimental plots as separately selectable, precisely cropped image objects when their underlying data cannot be recovered. Keep surrounding text and labels editable. Do not fabricate values or replace scientific evidence with generic icons.
- LaTeX-SVG equations are replaceable vector objects with editable LaTeX source, not native PowerPoint equation text. If the user requires in-place equation editing, use native Office Math via a compatible build path and verify it. State any remaining image or equation editability limits accurately.

## Audience-facing language

- Show research content and conclusions only. Keep layout decisions, production notes, and source-tracking labels out of slide text.
- Put provenance, equation references, and caveats in speaker notes and the evidence ledger. Do not visibly print “公式来源”, “论文结果”, “根据论文”, “未运行作者代码”, “用于补充版面”, or “此处放置”.
- Translate English figure labels into concise Chinese. Keep necessary abbreviations in parentheses on first use.
- Highlight a few decisive keywords in red; never color an entire paragraph red.

## Typography and charts

- Never use visible text below 10 pt. Prefer the 10/12/14/16 pt ladder for diagrams, chart labels, body text, and panel headers. Convert explicitly to the API's pixel units where needed.
- Left-align summary text and fill its available box without crowding.
- Keep axes, units, ticks, and legends legible after projection. Use at least 10 pt for ticks/legends and 11–12 pt for axis titles.
- Fix axis ranges and major units from the document or an explicit comparison rule. Keep 5–7 major ticks and consistent series order, color, and line style. Place legends outside the data region.
- Use white plot backgrounds, dark-gray axes and plot borders, and light-gray dashed major gridlines in both directions.
- Distinguish methods by color, line style, and marker together. Use a thicker solid navy line with a larger circular marker for the focal method.
- Keep chart/table source references in notes rather than visible footers.

## Evidence boundaries

- Every visible number, formula, relationship, and claim must resolve to a document page, section, equation, table, figure, or supplement.
- Treat supplied and bundled editable example decks as evidence of layout and visual hierarchy, not as the numerical authority. Recheck their costs, percentages, topology labels, case definitions, and algorithm timings against the corresponding paper before reusing them. If paper and deck disagree, use the paper and record the discrepancy.
- Replot only exact available values. When curve data are unavailable, use a source crop or a supported table; do not invent sampled points.
- Record source inconsistencies and missing evidence in the ledger. Do not silently select a more favorable value.
- Preserve scientific meaning while redesigning the layout: edge direction, essential branches, variables, and operations are evidence.
- Published results can be presented as reported evidence without running the authors' code. Never describe them as independently reproduced experiments.

## Deliverables

Deliver the final editable PPTX. Retain the task-specific builder, content spec, forecasting method graph or planning model record, visual design spec, evidence files, required source crops, formula source/assets when used, and validation receipts in the task build directory. Final-slide renderings are internal QA artifacts; they are not a prerequisite design deliverable. Do not create a prompt package, preview-image package, or image-reconstruction package.

## 服务器构建入口

先按 references/two-slide-spec.md 提取真实论文内容，运行 scripts/validate_two_slide_spec.py。随后：

```bash
SPEC_PATH=/absolute/spec.json FINAL_PPTX=/absolute/output.pptx node scripts/build_two_slide_deck.mjs
```

该入口用原生可编辑文本、图形、连接线、图表和表格，离线 MathJax SVG 公式保留 LaTeX 与公式清单。支持 resultModules 和旧版 charts/thirdModule；复杂方法图可传 methodGraphPath，按真实节点与有向边绘制。模板样例是版式参照，不代表自动导入母版；需要严格母版继承时使用系统 PPTX 工具并显式验收。原外部运行时版本保留为 build_two_slide_deck_artifact.mjs。PowerPoint COM 修复脚本仅限 Windows，Linux 使用构建器样式与 LibreOffice 验收。
