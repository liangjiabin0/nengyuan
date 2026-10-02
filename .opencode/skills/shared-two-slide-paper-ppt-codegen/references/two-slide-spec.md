# Two-slide content specification

The task-specific builder reads a UTF-8 JSON file. Keep source references in `evidenceRef` fields and speaker notes; do not render them as slide footers. Select the planning or forecasting route in `meta.paperType`. The older starter builder uses a fixed `charts` plus `thirdModule` result layout; adapt it when using the flexible `resultModules` below.

```json
{
  "meta": {
    "paperTitle": "...",
    "paperType": "forecasting",
    "doi": "...",
    "sourcePath": "absolute source document path",
    "templatePptx": "optional absolute editable sample PPTX",
    "fontFamily": "Microsoft YaHei",
    "slideSize": {"width": 1280, "height": 720}
  },
  "slide1": {
    "title": "1. 论文原理与计算流程 --- 具体方法名称",
    "summaryRuns": [
      {"text": "关键结论：", "emphasis": "red"},
      {"text": "面向听众的论文方法概括。"}
    ],
    "layoutMode": "integrated-flow | content-regions",
    "methodGraphPath": "absolute path to validated method-graph.json",
    "panels": [
      {
        "title": "...",
        "visualMode": "native-diagram",
        "steps": ["..."],
        "details": ["..."],
        "formulaIds": ["eq-1"],
        "conclusion": "最多两行的研究结论",
        "evidenceRef": "PDF p.5 Fig.2"
      }
    ],
    "formulas": [
      {
        "id": "eq-1",
        "latex": "Q_{\\mathrm{fft}}[k]=\\sum\\nolimits_{t=0}^{L-1}Q_t e^{-i2\\pi tk/L}",
        "evidenceRef": "PDF p.6 Eq.7"
      }
    ]
  },
  "slide2": {
    "title": "2. 对比算例与实验结果 --- 数据集或场景",
    "summaryRuns": [
      {"text": "主要结果：", "emphasis": "red"},
      {"text": "用两行以内给出量化结论。"}
    ],
    "resultModules": [
      {
        "title": "整体性能或规划经济性",
        "conclusion": "...",
        "evidenceRef": "Table III",
        "visuals": [{
          "type": "chart",
          "categories": ["1", "6", "12"],
          "xTitle": "预测步长",
          "yTitle": "MSE",
          "yMin": 0,
          "yMax": 60,
          "yMajorUnit": 10,
          "focusSeries": "Method",
          "series": [{"name": "Method", "values": [1, 2, 3]}],
          "evidenceRef": "Table III"
        }]
      },
      {
        "title": "关键机制或消融",
        "conclusion": "...",
        "evidenceRef": "Table IV",
        "visuals": [{"type": "table", "headers": ["方法", "指标"], "rows": [["Method", "0.000"]], "evidenceRef": "Table IV"}]
      },
      {
        "title": "计算表现或典型时段",
        "conclusion": "...",
        "evidenceRef": "Fig. 4",
        "visuals": [{"type": "diagram", "description": "来自论文的可编辑关系图或阶段图", "evidenceRef": "Fig. 4"}]
      }
    ]
  }
}
```

## Content invariants

- `summaryRuns` is rendered left aligned and must describe the research, not slide construction.
- `slide1.panels` may contain one integrated flow, two regions, or three regions. Do not force three cards when the original method is one continuous computation graph.
- For forecasting, `slide1.methodGraphPath` points to the validated computation graph and the slide exposes its inputs, final prediction, and applicable training-only lane. For planning, set `meta.paperType` to `planning`, replace `methodGraphPath` with `methodModelPath` pointing to `planning-model.md`, and expose decision owners, objective, decisive constraints, solver exchanges, and final plan.
- Design native diagram objects from `method-graph.json` and `visual-design-spec.md`. Check that important nodes, directed edges, groups, and labels express the documented method correctly. Source figures provide semantic evidence rather than a pixel-layout target.
- Formula display uses `latex`; `evidenceRef` is never printed on the slide.
- Slide 2 contains exactly three thematic modules, selected from the relevant [planning](planning-paper.md) or [forecasting](forecasting-paper.md) evidence. Each module has one or more visuals. Supported visual types are `chart`, `table`, `diagram`, `source-figure`, and `metrics`. A source figure needs `assetPath`; a native diagram needs a source-grounded `description` and task-specific drawing data. Use a chart only when exact values can be traced to the paper.
- Conclusions are audience-facing claims of at most two lines.

## Layout and type scale

- Canvas follows the editable template. Default: 1280 × 720.
- Title: 28–34 pt.
- Summary: 16–20 pt, left aligned.
- Panel headers: 14–18 pt.
- Diagram/body text: 10–14 pt; never below 10 pt.
- Chart legend/ticks: at least 10 pt. Axis titles: 11–12 pt.
- Use a 10/12/14/16 pt ladder before introducing intermediate sizes.
- A text-bearing colored card should normally be one shape with text. If separate text and background shapes are unavoidable, their bounding boxes must match exactly.

## Chart invariants

- Read and follow [result-chart-style.md](result-chart-style.md) for result-page comparison charts. Apply plot gridlines and line-series styling to actual charts, not to topology diagrams, tables, or raster evidence.
- Keep one method's color and marker consistent across all charts.
- Place the legend above or outside the plot with overlay disabled.
- Use roughly 5–7 major ticks and explicit axis bounds/major units when they suit the data.
- Use a white chart and plot background, a visible dark-gray plot border, and light-gray dashed major gridlines on both axes.
- Use line style plus marker shape in addition to color. The `focusSeries` uses the thick solid navy line and larger circle; when omitted, the last series is treated as the focal method.
- Do not append `/ step` to an already clear Chinese label unless the paper requires bilingual notation.
- Do not render `evidenceRef` under charts; put it in notes.
