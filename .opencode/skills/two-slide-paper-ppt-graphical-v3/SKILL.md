---
name: two-slide-paper-ppt-graphical-v3
original_name: two-slide-paper-ppt-codegen
description: Turn a power-system paper or multi-chapter thesis into a two-slide editable academic PPT, covering planning, operation, markets, control, detection or forecasting. Preserve core contributions in graphical method frameworks and evidence-rich results, using templates, semantic diagrams, comparison checks and final-render gates.
---

# Two-slide paper PPT codegen

Read the source document, design two audience-ready slides, and directly create the editable PPTX. Do not modify `technical-report-ppt-pipeline`.

The production path is document → evidence and method logic → slide design → editable PPTX → final quality check. Do not generate image-generation prompts, slide preview drafts, or reference-image reconstruction scripts. Do not require preview approval before building the PPTX. Rendering an exported PPTX for final quality inspection is a verification step, not a preview-design stage.

## Graphical quality standard

The first slide must explain the paper through a **source-grounded editable diagram**, supported by adjacent equations and concise explanations. Template fidelity includes information hierarchy and relationship structure, not only blue colors, headers and columns. Text cards connected as a generic list do not meet this standard when the paper contains systems, decision owners, coupling, feedback or branching. An image/shape count is not a quality target.

Read [references/graphic-method-workflow.md](references/graphic-method-workflow.md) for every paper. It defines mandatory semantic graph/layout artifacts, native-object coverage, final-render review, and bounded repair. Select an appropriate approved reference from [references/graphic-reference-cases.md](references/graphic-reference-cases.md); the four graphical revision decks are bundled alongside the original templates. Preserve scientific meaning rather than imposing the same arrangement on different papers.

For a thesis or paper with multiple substantial contributions, also read [references/multi-contribution-paper.md](references/multi-contribution-paper.md). Inventory the core chapters before choosing a route. Require a contribution map linking each core method to its diagram and result theme, preserve alternative treatment paths, and keep scenario/metric/accounting bases explicit. A two-slide summary must not silently omit a core chapter or portray proposed-but-unused forecasting as validated experiments.

## Workflow

1. Read the complete source document with the appropriate PDF or Documents skill. Inspect method sections, diagrams, equations, result tables, captions, and limitations together. Extract only the source figures needed as evidence.
2. Inspect a supplied editable template or sample PPTX. When using this skill's bundled examples, planning papers should reference the PPTX files in [assets/reference-pptx/规划类](assets/reference-pptx/规划类), and forecasting papers should reference those in [assets/reference-pptx/预测类](assets/reference-pptx/预测类). In the selected deck, slide 1 guides the paper's principle/method slide; slide 2 guides the case-study/experimental-results slide. Reuse the relevant slide ratio, background, title system, margins, summary box, colors, and visual hierarchy. If neither supplied nor bundled references fit the paper, use a 16:9 blue/teal academic theme.
3. Classify by the main contribution. Prediction: read [references/forecasting-paper.md](references/forecasting-paper.md), reconstruct `method-graph.json` following [references/method-graph-workflow.md](references/method-graph-workflow.md), and run `scripts/validate_method_graph.py`. Planning/operation/market optimization: read [references/planning-paper.md](references/planning-paper.md) and retain `planning-model.md`. Control/stability/detection: read [references/control-paper.md](references/control-paper.md) and retain `control-model.md`. Every route also requires `semantic-graph.json`, covering the objects and relationships actually shown on slide 1. A prose model record never replaces this graph. Mixed papers follow their main contribution with the other mechanisms retained where relevant.
4. Design the two slides directly from the documented method and evidence. Record template inheritance, layout, hierarchy, object positions, connector paths, and formula placement in `visual-design-spec.md` and executable `diagram-layout.json`. Validate the graph and layout with `scripts/validate_semantic_graph.py`. Establish the main diagram before adding exposition. Use the source's real power/signal/price/decision relationships; do not copy source-image pixel geometry.
5. Build a content spec following [references/two-slide-spec.md](references/two-slide-spec.md), plus `source-index.json` and `evidence-ledger.json`. Record source locations for all claims, formulas, relationships, and numerical data. Validate the content spec with `scripts/validate_two_slide_spec.py`.
   For multi-contribution sources, set `meta.documentKind` and `meta.contributionMapPath`; use identified result modules with `caseIds`. The validator also runs `scripts/validate_contribution_map.py` to check chapter coverage and arithmetic comparison compatibility.
6. Use the Presentations skill and its supported runtime for the main build. Prefer a task-specific builder that preserves the selected template and draws the validated graph. `scripts/draw_semantic_diagram.mjs` provides reusable native symbols and explicitly routed relationships. The starter `scripts/build_two_slide_deck.mjs` now draws the semantic graph instead of a text-step grid; its chrome remains 1280×720 and its result page remains two charts plus a table. It rejects template imports, other slide sizes, and unsupported result layouts instead of silently degrading them. Adapt the builder for those cases. Preserve native object naming and save `diagram-coverage.json` for final exported-object verification.
7. Draw text, module boxes, connectors, tables, and data-backed charts as native PowerPoint objects. Place formulas beside their operations. When formulas are present, follow [references/formula-svg-workflow.md](references/formula-svg-workflow.md) and retain canonical LaTeX plus `formula-manifest.json` for revision.
8. Export the PPTX, run `scripts/audit_visible_pptx.py` and the Presentations package/layout checks, then inspect a rendering of every final slide against the selected reference and manuscript. Fix missing mechanisms as well as clipping, overlaps, unreadable labels, misplaced arrows, missing equations, and chart errors. Confirm text, diagrams, tables, and data-backed charts remain editable. Verify SVG equations with PowerPoint rendering because some secondary renderers omit them. Record the observed checks in `visual-review.json`, bound to the final PPTX, graph, layout, coverage and render hashes; run `scripts/audit_graphic_delivery.py`. A package-valid deck without completed visual review is not a finished deliverable. Follow the bounded repair procedure instead of falling back to text-only slides.

When slide 2 contains any coordinate plot (including line, bar, and scatter charts), read [references/result-chart-style.md](references/result-chart-style.md). Use `scripts/apply_result_chart_style.ps1` for native chart style repair and `scripts/audit_plot_axes.py <deck.pptx>` to inspect explicit ranges, major ticks, two-direction gridlines, fonts, and legend placement. Still render every final slide in PowerPoint.

After importing template masters/layouts, run `scripts/audit_template_bindings.py <deck.pptx>`. Each slide's layout must belong to its registered master, and the master must list that layout. Copying a master while retaining an old slide-to-layout reference can pass generic package checks yet fail to open in PowerPoint. Resolve references explicitly; preserve template assets and never treat successful alternate-tool import as proof of PowerPoint compatibility. Detect charts by package relationships or `/charts/chart` paths, including nested paths, rather than assuming `ppt/charts`.

## Slide contract

- Slide 1: paper-specific method title and a left-aligned summary of at most two lines. Forecasting shows its computation graph. Planning/operation/market papers show the decision architecture, the objective equation with term meanings and units, source-grounded key constraint equations with adjacent physical/economic explanations, and the actual solver or operating sequence. Give the mathematical model enough space to be read; supporting prediction or scenario-generation pipelines are supporting regions. Follow the relevant branch reference.
- Control/detection slide 1: show the physical system, signal/measurement paths, controller operations or detection mechanism, and defining equations. Show feedback only when present in the source. Do not force a planning objective onto a controller paper. All routes retain their contribution-defining relationships as native diagram objects.
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
- Keep different chapter baselines and accounting bases separate. A composite risk score is not a probability; equivalent aging hours are not clock time. Do not compute a savings percentage between annual net cost and annual planning cost. Distinguish proposed methods from those actually exercised by the case study, and avoid strengthening "near a limit" into "all limits satisfied".
- Preserve scientific meaning while redesigning the layout: edge direction, essential branches, variables, and operations are evidence.
- Published results can be presented as reported evidence without running the authors' code. Never describe them as independently reproduced experiments.

## Deliverables

Deliver the final editable PPTX. Retain the task-specific builder, content spec, domain model record, semantic graph, diagram layout, native-object coverage, visual design spec, evidence files, required source crops, formula source/assets when used, final-slide renders, and hash-bound validation/review receipts in the task build directory. Final-slide renderings are internal QA artifacts, not a prerequisite approval stage. Do not create a prompt package, preview-image package, or image-reconstruction package. If required gates remain unresolved after bounded repair, identify the candidate as incomplete and report the actual blocker; do not assert guaranteed quality.
