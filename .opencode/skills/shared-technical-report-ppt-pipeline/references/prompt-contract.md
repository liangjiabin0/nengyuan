# Prompt-pack contract

## Global prompt structure

The global prompt must contain these immutable blocks in this order:

1. output format and 16:9 canvas;
2. exact template reference and fixed master regions;
3. typography and color semantics;
4. content-safe region;
5. source and data fidelity rules;
6. formula-display rules;
7. editability intent for later reconstruction;
8. negative constraints.

Required template lock language when the user supplies a template/reference:

> Strictly preserve the latest reference template's measured header, title baseline,
> separator, logo safe area, fixed decoration, footer, and page-number location.
> Treat those regions as immutable. Only replace the page-specific title, page
> number, and content inside the designated safe area.

Do not mention a tower icon, decorative square stack, or gradient footer unless
those elements exist in the current template. When no newer template is supplied,
use `green-technical-report-style.md` as the default visual profile.

Required source-fidelity language:

> Use only statements, numbers, formulas, tables, and figures listed in the supplied
> evidence ledger. Do not invent values, percentages, scales, device capacities,
> prices, efficiencies, or conclusions.

When the restrained green research profile applies, the global prompt must also
state:

> Use green as the primary color with white and neutral gray. Limit each page to
> one green family and at most three chromatic colors, including chart series.
> Keep the style spacious, institutional, and concise. Do not use a rainbow icon
> set or unrelated blue, orange, and purple accents.

> Prefer an upper narrative and lower evidence composition: concise editable text
> in the upper 25%–35%, with one or two large figures, charts, or diagrams below.
> For formula-first pages, reserve a clean central formula frame and do not ask the
> image model to typeset the authoritative equation.

## Per-slide prompt structure

Each slide prompt must contain:

```text
Slide ID and page number
Narrative job / single takeaway
Main title and subtitle
Mapped template source slide
Exact content-safe-area composition with coordinates or percentages
Visible text, already compressed
Figures/tables/charts with source asset IDs
Formula blocks with formula-manifest IDs
Color semantics
Explicit negative constraints
Expected visual QA checks
```

Avoid vague placement such as “left” or “center” when a measurable frame exists.
State columns, panel bounds, alignment, and relative heights.

## Formula-heavy preview rule

Image generation validates composition, not equation truth. Do not let the image
model improvise equations. In formula-heavy previews:

- copy the exact display form from the formula manifest;
- reserve one bounded formula frame per equation group;
- keep equation identifiers visible and separated from body copy;
- reject raw LaTeX, broken subscripts, missing symbols, and substituted variables;
- require the final PPT reconstruction to use native Office math objects.
- use Cambria Math for the final native equation unless the measured template
  specifies another verified math font;
- keep formulas monochrome dark green or near-black and avoid colored variables;
- preserve normalized formula crop bounds for high-resolution render comparison.

## Visual selection rules

- Prefer a report figure if it carries evidence.
- Use native charts later when underlying data are available.
- Use image generation only for non-evidentiary scientific illustration or layout
  preview.
- Keep complex equipment illustrations independent from text and charts.
- Never merge the whole module into a single image for the final PPT.
- For electrical, energy, data, calculation, vehicle, storage, charging,
  discharging, forecasting, photovoltaic, wind-power, grid, market, and risk
  icons, use only the pinned local `electrical-icons` allowlist. Image generation
  must reserve icon frames and composite the exact SVG afterward; it must not
  invent or redraw icons.

## Negative constraints

Always prohibit:

- master redesign, duplicate header/footer/page number, and extra logos;
- auto-added section numbers not present in the source;
- full-slide screenshots as final PowerPoint backgrounds;
- dense UI cards, decorative 3D models, unrelated skylines, and people;
- fabricated figures, scales, percentages, citations, and software interfaces;
- formula source code, incorrect glyph substitutions, or approximate superscripts;
- overlapping text, arrows through labels, clipped formulas, and wrapped one-line
  titles.
- rainbow palettes, multi-color icons, decorative formula cards, and more than
  three chromatic colors on a restrained-green page.

## Approval gate

Show the global prompt and every per-slide prompt in page order. Do not invoke image
generation until the user approves, unless the user explicitly asked to proceed
without pausing.
