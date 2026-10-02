---
name: shared-technical-report-ppt-pipeline
title: "ppt（自由版）"
description: "Convert Chinese technical reports, research reports, project documents, papers, DOCX/PDF sources, and a supplied or bundled PowerPoint template into source-grounded slide outlines, a global image-generation prompt, per-slide prompts, GPT image preview drafts, and a template-faithful editable PPTX. Use for end-to-end technical-report-to-PPT work, especially power systems, zero-carbon parks, integrated energy systems, optimization scheduling, formula-heavy research presentations, preview-first workflows, and requests requiring strict master inheritance, editable charts/diagrams, exact equations, or visual QA."
---

# Technical Report to PPT Pipeline

Build a report-grounded deck through explicit approval gates. Preserve the source
template, never invent evidence, and treat equations as structured mathematical
objects rather than ordinary text.

## Required companion skills

- Use the Documents skill to read DOCX sources and the PDF skill to read PDF sources.
- Use the Presentations skill for all PPTX inspection, authoring, rendering, and QA.
- Use the imagegen skill only after the user approves the prompt pack.
- Follow the Presentations skill's template-following workflow and use
  `@oai/artifact-tool`; never use `python-pptx` or mutate PPTX XML directly.

## Set up the workspace

Create a task-specific temporary directory and define:

```bash
SKILL_DIR=<absolute path to this skill>
TMP_DIR=<task-specific temporary directory>
SOURCE_REPORT=<source DOCX or PDF>
SOURCE_TEMPLATE=<user template, or blank when the measured green profile is used>
FINAL_PPTX=<requested output path>
EXPECTED_RATIO=<reference-derived or user-specified ratio, such as 16:9 or 4:3>
```

Use the user's current template when supplied. Use the bundled template only when
the user asks for the established zero-carbon-park style. When no newer template
or brand system is supplied, use the restrained green technical-report profile in
[references/green-technical-report-style.md](references/green-technical-report-style.md)
as the preview and authoring art direction. Use
`$SKILL_DIR/assets/zero-carbon-park-template.pptx` only when that legacy style is
requested. Do not overwrite source files.

## Run the gated workflow

### Gate 0 — Confirm inputs and scope

Resolve the report, template, intended audience, presentation purpose, outline or
page count, and any mandatory sections. Ask only for missing facts that materially
change the result. Record assumptions in `$TMP_DIR/source-notes.txt`.

### Gate 1 — Read and index every source

Read the selected source completely; do not rely on snippets. For DOCX, optionally
run:

```bash
python3 "$SKILL_DIR/scripts/extract_report.py" \
  "$SOURCE_REPORT" --output-dir "$TMP_DIR/source-extract"
```

For PDF, use the PDF skill and create equivalent extracted text and page renders.
Read [references/content-extraction.md](references/content-extraction.md) and build:

- `source-index.json`: sections, figures, tables, equations, and locations;
- `evidence-ledger.json`: every claim, number, formula, figure, and source location;
- `asset-ledger.json`: source figures and their permitted use/crop;
- `formula-manifest.json`: exact source formula, semantic roles, numbering, and page use.

Reject invented values, unsupported claims, fake interfaces, fake logos, and
unsourced diagrams presented as report evidence.

### Gate 2 — Inspect the template before writing slides

Inspect and render every template slide with the Presentations template-following
workflow. Preserve master → layout → slide inheritance. Read
[references/template-profile.md](references/template-profile.md) for the bundled
template's measured frames. Create `template-audit.txt` and
`template-frame-map.json`; map every planned slide to a real source slide.

If the user requests a green, simple, institutional research style or supplies the
`38-2分钟汇报PPT.pdf` visual sample, also read
[references/green-technical-report-style.md](references/green-technical-report-style.md).
Apply its limited palette and upper-narrative/lower-evidence frames unless a newer
explicit template measurement overrides them.

When the legacy bundled PPTX is selected, use these source-slide roles:

- slide 1: cover;
- slide 2: theory, model, mechanism, constraint, framework, and formula pages;
- slide 3: case analysis, two-part comparison, plan/effect, and evidence pages.

Do not redraw fixed headers, footers, page-number regions, logo safe areas, or
other repeated decoration slide by slide.

### Gate 3 — Design the narrative and content plan

Define one communication job and one claim per slide. Extract domain keywords from
the report, then group them into problem, mechanism, model/constraint, framework,
case evidence, comparison, and conclusion roles. Prefer report figures and tables.

Create `content-plan.json` using
[references/content-plan-schema.json](references/content-plan-schema.json). Every
slide must identify its source section, source assets, formulas, layout family,
visible copy, and key takeaway. Shorten copy before shrinking type.

Validate the plan before generating prompts:

```bash
python3 "$SKILL_DIR/scripts/validate_content_plan.py" \
  "$TMP_DIR/content-plan.json"
```

### Gate 4 — Generate the prompt pack and pause for approval

Read [references/prompt-contract.md](references/prompt-contract.md), then write:

- one immutable global/master prompt;
- one precise prompt per slide;
- negative constraints and safe regions;
- exact source-asset instructions;
- a formula manifest reference for formula-heavy pages.

For restrained green previews, state the color budget and layout family explicitly:
one green family plus neutrals, no rainbow icon/chart palette, and upper text with
lower evidence by default. A formula-first page uses a reserved native-equation
frame instead of generated formula glyphs.

Optionally render the first draft with:

```bash
python3 "$SKILL_DIR/scripts/build_prompt_pack.py" \
  "$TMP_DIR/content-plan.json" \
  --output "$TMP_DIR/prompt-pack.txt"
python3 "$SKILL_DIR/scripts/validate_prompt_pack.py" \
  "$TMP_DIR/prompt-pack.txt"
```

Present the global prompt and per-slide prompts to the user. Stop here until the
user explicitly approves them or requests direct continuation.

### Gate 5 — Generate image previews after prompt approval

Use imagegen with the appropriate bundled template preview as the reference image.
For the restrained green profile, inspect
`assets/green-style-reference/contact-sheet.png` and use the relevant page of
`assets/green-style-reference/38-2分钟汇报PPT.pdf` as the visual reference. Treat its
report text and logo as non-transferable unless the current source authorizes them.
Generate slides sequentially so the fixed chrome remains consistent. The preview
validates composition, hierarchy, color, density, and asset placement.

For electrical, energy, data, calculation, vehicle, storage, charging,
discharging, forecasting, photovoltaic, wind-power, grid, market, and risk icons,
use only the local controlled library described in
[references/autonomous-image-replication.md](references/autonomous-image-replication.md).
Do not let image generation invent icons: reserve their frames and composite the
exact allowlisted SVGs into the preview.

Image models are not the authority for exact equations, labels, or data. For
formula-heavy slides, require reserved formula frames and compare the preview with
`formula-manifest.json`; never approve a misspelled or fabricated formula as source
truth. Present the previews and pause for approval before PPT reconstruction.

For restrained-green previews, run `scripts/audit_preview_palette.py`. Mask only
source figures whose original colors must remain; never mask generated icons or
decorative imagery merely to pass the color budget.

### Gate 6 — Reconstruct the approved preview as editable PPTX

When the task is to reproduce reference slide images as an editable PPTX, read
[references/editable-image-replication-prompt.md](references/editable-image-replication-prompt.md)
in full and use it as the execution prompt for inspection, measurement,
reconstruction, rendering, visual comparison, correction, and delivery. Replace
its angle-bracket placeholders with the resolved task inputs. The user's current
request and supplied files take precedence over task-specific defaults in the
prompt, while its fidelity, editability, measurement, and QA requirements remain
mandatory.

Also read
[references/autonomous-image-replication.md](references/autonomous-image-replication.md)
and follow its deterministic measurement, controlled-icon, automatic
render-and-repair, and hard completion gates. Resolve default icons with
`scripts/icon_registry.py`; external icon search is disabled unless the user
supplies an asset or the source template/reference contains it.

Use `@oai/artifact-tool` and the template-following starter-deck workflow. Duplicate
mapped source slides and edit inherited elements in place. Keep all titles, body
copy, shapes, lines, tables, charts, legends, axes, and page numbers editable.
Complex equipment illustrations may remain independent replaceable images, never
whole-slide screenshots.

For equations, read [references/formula-standard.md](references/formula-standard.md)
and use `$SKILL_DIR/scripts/native_formula.mjs`. Insert native Office math objects;
do not paste visible LaTeX, Unicode superscript approximations, or equation
screenshots. Use Cambria Math for native math unless a source template specifies a
different verified math font. Use italic scalar variables, bold italic
vectors/matrices, upright descriptive subscripts and function names, and true
structured subscripts/superscripts, fractions, radicals, sums, and matrices.
Validate `formula-manifest.json` before authoring:

```bash
python3 "$SKILL_DIR/scripts/validate_formula_manifest.py" \
  "$TMP_DIR/formula-manifest.json"
```

### Gate 7 — Render, compare, and correct every slide

Render each slide at full size immediately after authoring it. Compare against the
approved preview and mapped template slide. Check layout, title baseline, text
wrapping, images, charts, formulas, master consistency, page numbers, and source
accuracy. Do not wait until the entire deck is built before the first review.

Read [references/qa-standard.md](references/qa-standard.md). Run:

```bash
python3 "$SKILL_DIR/scripts/pptx_preflight.py" "$FINAL_PPTX" \
  --expected-ratio "$EXPECTED_RATIO" \
  --math-font "Cambria Math" \
  --output "$TMP_DIR/pptx-preflight.json"
python3 "$SKILL_DIR/scripts/audit_formula_pptx.py" \
  "$FINAL_PPTX" "$TMP_DIR/formula-manifest.json" \
  --output "$TMP_DIR/formula-audit.json"
bash "$SKILL_DIR/scripts/run_visual_qa.sh" \
  "$FINAL_PPTX" "$TMP_DIR/final-qa"
```

For reference-image replication, additionally run `measure_reference.py` before
authoring and `replication_qa.py` after every render. Use the comparison JSON and
heatmaps to repair each slide automatically; do not hand the user a deck that still
expects manual PowerPoint cleanup.

Fix all errors, render again, inspect every slide, create a contact sheet, and
perform at least one full correction pass. Reopen the exported PPTX before delivery.

## Non-negotiable quality rules

- Preserve the template hierarchy; never flatten the deck or use a full-slide
  screenshot as the background.
- Keep visible text audience-facing and source-grounded.
- Use report figures first; crop individual assets only, then rebuild their labels
  as editable text when practical.
- Never fabricate data, percentages, capacities, costs, efficiencies, or trends.
- Use native charts for known data and qualitative editable curves without fake
  numeric scales when the report provides only trends.
- Create connectors before nodes and keep arrows behind text.
- Do not allow clipping, unintended overlap, empty placeholders, duplicate page
  numbers, inconsistent fixed chrome, or raw formula markup.
- If an equation, figure, font, or source cannot be reproduced faithfully, identify
  the exact slide and element instead of pretending it is complete.

## Deliverables

At the prompt stage, deliver the global prompt and ordered per-slide prompts. At
the preview stage, deliver the ordered slide previews. At the build stage, deliver
only the final PPTX and a concise note on sources, font substitutions, and any
explicitly unresolved fidelity limitation.
