# Bundled template profile

This profile describes `assets/zero-carbon-park-template.pptx`. Reinspect any newer
user-supplied template; do not assume it matches this file.

## Canvas and hierarchy

- Aspect ratio: 16:9.
- Render frame: 1280 × 720 px.
- PowerPoint size: 13.333 × 7.5 in.
- Slides: 3.
- One master and one inherited layout.
- Fixed background, decorative squares, horizontal rule, arrows, footer gradient,
  tower-line background, and footer structure are inherited from the master.

## Fixed master geometry in 1280 × 720 coordinates

| Element | x | y | w | h | Notes |
|---|---:|---:|---:|---:|---|
| Teal title rule | 0 | 79.24 | 1280 | 6.34 | `#006F69` |
| Chevron 1 | 93.69 | 76.45 | 11.10 | 11.93 | preserve |
| Chevron 2 | 104.79 | 76.45 | 11.10 | 11.93 | preserve |
| Chevron 3 | 115.90 | 76.45 | 11.10 | 11.93 | preserve |
| Dark teal square | 26.93 | 12.61 | 35.46 | 35.46 | `#006F69` |
| Small pale teal square | 57.46 | 53.03 | 14.54 | 14.47 | 23% teal |
| Orange overlay square | 16.62 | 24.81 | 35.46 | 35.46 | 47% `#FC9804` |
| Footer | 0 | 665.77 | 1280 | 54.23 | inherited gradient |

Never recreate these elements locally on each slide.

## Slide roles

### Source slide 1 — cover

Use only for the deck cover or section cover. Preserve the dark teal visual field and
the lower energy-system line art.

### Source slide 2 — technical content

Use for model, mechanism, constraint, framework, method, market, uncertainty, and
formula pages.

| Editable element | x | y | w | h |
|---|---:|---:|---:|---:|
| Main title frame | 81.80 | 18.67 | 959.24 | 107.93 |
| Subtitle frame | 70.94 | 93.71 | 1202.75 | 41.87 |
| Tower icon | 36.89 | 94.33 | 26.46 | 39.16 |
| Page-number placeholder | 1193.62 | 668.10 | 67.94 | 38.33 |

Recommended content-safe region: x 36–1244, y 148–654. Retain at least 12 px of
clearance above the footer.

### Source slide 3 — case analysis

Use for plan/effect, before/after, scheme/result, two-scenario comparison, and paired
evidence layouts.

| Editable element | x | y | w | h |
|---|---:|---:|---:|---:|
| Summary frame | 36.18 | 148.88 | 1207.45 | 94.36 |
| Left evidence panel | 36.87 | 273.71 | 579.60 | 388.03 |
| Right evidence panel | 639.90 | 273.71 | 590.43 | 388.03 |
| Left vertical label | 16.85 | 377.22 | 40.07 | 160.28 |
| Right vertical label | 623.46 | 377.97 | 40.07 | 160.28 |
| Page-number placeholder | 1193.62 | 668.10 | 67.94 | 38.33 |

Keep the summary to 3–4 concise lines. Each lower panel should contain one main
figure plus 2–4 interpretive statements, not a dense card wall.

## Typography and palette

- Chinese: Microsoft YaHei / 微软雅黑; preserve source weights and spacing.
- Ordinary English and numbers outside equations: Times New Roman. Native Office
  Math uses Cambria Math unless the source equation style is explicitly measured
  and verified.
- Large title: user-standard 28 pt when editing this template.
- Subtitle: user-standard 20 pt.
- Body and summary: user-standard 17 pt unless an inherited source frame proves a
  different size.
- Dark ink: `#003B32` or inherited deep green.
- Primary teal: `#006F69`; tower icon: `#004C3E`.
- In this legacy bundled template only, blue may represent electrical energy,
  orange heat/cost/risk, cyan cooling/rolling correction, and green
  storage/low-carbon/renewables. Do not apply that multi-color semantic palette
  when the restrained green profile is selected.

## Preview references

- `assets/template-preview-cover.png`
- `assets/template-preview-content.png`
- `assets/template-preview-case-analysis.png`

Use exactly one relevant preview as the image-generation reference for each slide.
