# Result-page comparison chart standard

Use this standard for slide 2 quantitative comparison charts where axes and gridlines help read values. It preserves the reviewed decks' shared chart conventions while keeping labels readable. A topology map, scenario tree, heatmap, or source figure should keep its own appropriate visual grammar.

## Plot and axes

- Chart area and plot area: solid white, without gradients.
- Plot border and both axis lines: visible `#595959`, 1.1–1.5 pt.
- Major gridlines: visible on both category and value axes, `#A6A6A6`, dashed, 0.8–1.1 pt, behind the data.
- Do not substitute horizontal-only solid gridlines.
- Use explicit value-axis minimum, maximum, and major unit from the paper or a stated comparison rule. Keep roughly 5–7 labeled major ticks when the range allows; use a log axis only for an evidenced order-of-magnitude comparison and mark it visibly.
- Tick labels: at least 10 pt. Axis titles: 11–12 pt. Use a Chinese-capable font when any label contains Chinese.

## Legend and series

- Place the legend above the plot with overlay disabled. Keep it outside the data region and use at least 10 pt text.
- Keep the series order identical across paired charts that compare the same methods or cases. A planning cost category and a forecast metric need their own meaningful order.
- For line charts with a focal method, use navy `#004BA0`, solid line, 2.4–3.2 pt, circular marker size 8. Use thinner, distinct line and marker styles for baselines; preserve a paper-mandated color when it carries meaning.
- Never rely on color alone to distinguish methods.

## Result-page geometry

- Keep three parallel evidence themes. Within a theme, align stacked visuals; give truly paired charts matching frames, plot sizes, and legend heights. Do not force a table, network map, or example trace into chart geometry.
- Fill each region rather than leaving large unused margins. Axis labels and legends must not be shrunk to compensate for whitespace.
- Keep the conclusion below each module to two lines or fewer.

## QA

Render the final deck through PowerPoint and check all result slides at full size. Confirm:

1. Horizontal and vertical dashed gridlines are visible where both axes are quantitative or categorical positions that benefit from reading across the plot.
2. The plot border and axes are visible but lighter than the primary series.
3. Legends do not cover curves.
4. Tick labels, axis titles, and units remain readable.
5. Series colors, line styles, markers, axis bounds, and category order are consistent across paired charts and are appropriate to each metric.

For an existing native-chart deck, run `scripts/apply_result_chart_style.ps1` on a copy, then compare unchanged slides and non-chart regions against the source.
